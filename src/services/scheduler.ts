import cron from "node-cron";
import { Bot } from "grammy";
import { GreetingType } from "../prisma/enums";
import { prisma } from "../lib/prisma";
import {
  getReminderMessage,
  MORNING_GREETINGS,
  MOTIVATIONAL_SHORTS,
  pickRandomMessage,
  scheduleNextJob,
} from "../bot/reminders";
import { sendSceneViaApi } from "../utils/constants";
import { captureReplayError } from "./replayCapture";
import { getLocalDayOfWeek, localTimeToUtc } from "../utils/dateHelpers";
import type { BotContext, SessionData } from "../bot/types";
import { parseISO, differenceInDays } from "date-fns";
import { canCreateLog, FREE_LOG_LIMIT, getStorageLimitReachedAfterSaveText, getStorageWallText, hasActiveStorage } from "../bot/monetization";

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const BROADCAST_TIMEZONE = "Africa/Lagos";
const WAT_OFFSET_MS = 60 * 60 * 1000;

// Lagos is UTC+1 year-round (no DST), so this gives a stable start-of-day boundary.
function getStartOfTodayInWAT(): Date {
  const shifted = new Date(Date.now() + WAT_OFFSET_MS);
  shifted.setUTCHours(0, 0, 0, 0);
  return new Date(shifted.getTime() - WAT_OFFSET_MS);
}

function pickRandomSubset<T>(items: T[], size: number): T[] {
  if (size <= 0 || items.length === 0) return [];
  if (size >= items.length) return items;

  const shuffled = [...items];
  for (let i = shuffled.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
  }

  return shuffled.slice(0, size);
}

// ---------------------------------------------------------------------------
// Weekly Recap — exported so the admin router can trigger it on-demand.
// Called automatically every Saturday at 11:00 UTC (12:00 WAT).
// ---------------------------------------------------------------------------

/**
 * Build and send the Saturday weekly recap to every onboarded, non-blocked user.
 * Returns how many messages were sent vs failed.
 */
export async function sendWeeklyRecap(bot: Bot<BotContext>): Promise<{ sent: number; failed: number }> {
  const now = new Date();

  // ── Compute this week's Monday 00:00 UTC and Friday 23:59:59 UTC ─────────
  // getUTCDay(): 0=Sun, 1=Mon, …, 6=Sat
  const utcDay = now.getUTCDay();
  const daysToMon = (utcDay - 1 + 7) % 7; // distance back to Monday

  const monday = new Date(now);
  monday.setUTCDate(monday.getUTCDate() - daysToMon);
  monday.setUTCHours(0, 0, 0, 0);

  const friday = new Date(monday);
  friday.setUTCDate(friday.getUTCDate() + 4);
  friday.setUTCHours(23, 59, 59, 999);

  // ── Determine current IT week number ─────────────────────────────────────
  // IT_START_DATE should be the Monday of IT Week 1 in ISO format (YYYY-MM-DD).
  // Defaults to 2026-03-02 (the first Monday of the IT cohort).
  const itStartIso = process.env.IT_START_DATE ?? "2026-03-02";
  const itStartDate = new Date(`${itStartIso}T00:00:00.000Z`);
  const diffMs = monday.getTime() - itStartDate.getTime();
  const weekNumber = Math.max(1, Math.floor(diffMs / (7 * 24 * 60 * 60 * 1000)) + 1);

  // ── Fetch the quote for this week (cycle if we don't have that week yet) ──
  const totalQuotes = await prisma.weeklyQuote.count();
  let quoteRow: { quote: string; attribution: string | null } | null = null;

  if (totalQuotes > 0) {
    const cycledWeek = ((weekNumber - 1) % totalQuotes) + 1;
    quoteRow = await prisma.weeklyQuote.findFirst({
      where: { weekNumber: cycledWeek },
      select: { quote: true, attribution: true },
    });
    // Belt-and-braces fallback to week 1
    if (!quoteRow) {
      quoteRow = await prisma.weeklyQuote.findFirst({
        orderBy: { weekNumber: "asc" },
        select: { quote: true, attribution: true },
      });
    }
  }

  // ── Fetch all onboarded, non-blocked users ────────────────────────────────
  const users = await prisma.user.findMany({
    where: { onboardingDone: true, botBlocked: false },
    select: { id: true, telegramId: true, firstName: true },
  });

  const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  let sent = 0;
  let failed = 0;

  for (const user of users) {
    try {
      // ── Fetch this user's Mon-Fri logs ──────────────────────────────────
      const logs = await prisma.log.findMany({
        where: {
          userId: user.id,
          logDate: { gte: monday, lte: friday },
        },
        select: { logDate: true, content: true },
        orderBy: { logDate: "asc" },
      });

      // Map by day offset from Monday (0 = Mon … 4 = Fri)
      const logsByDay = new Map<number, string>();
      for (const log of logs) {
        const offsetMs = log.logDate.getTime() - monday.getTime();
        const dayOffset = Math.round(offsetMs / (24 * 60 * 60 * 1000));
        if (dayOffset >= 0 && dayOffset <= 4) {
          // Keep the LAST log if a user somehow wrote two on the same day
          logsByDay.set(dayOffset, log.content);
        }
      }

      const loggedCount = logsByDay.size;

      if (loggedCount === 0) {
        console.log(`[weekly-recap] Skipped user ${user.id} — no logs this week`);
        continue;
      }

      // ── Per-day recap lines ────────────────────────────────────────────
      const dayLines = DAYS.map((day, i) => {
        const content = logsByDay.get(i);
        if (content) {
          const preview =
            content.length > 100 ? content.slice(0, 100).trimEnd() + "…" : content;
          return `${day} — ${preview} 📝`;
        }
        return `${day} — nothing logged that day 👀`;
      });

      // ── Motivation line ────────────────────────────────────────────────
      let motivationLine: string;
      if (loggedCount === 5) {
        motivationLine =
          "You logged every single day this week 🔥 Your logbook is going to be immaculate.";
      } else if (loggedCount >= 3) {
        motivationLine =
          `Solid week! The missed days can still be filled in — tap *"Fill in missed days"* and catch up before you forget 🙏`;
      } else if (loggedCount >= 1) {
        motivationLine =
          `This week was rough — no judgement 😅 But go fill in what you remember before the details fade. Future you needs this.`;
      } else {
        motivationLine =
          `No logs this week, ${user.firstName}. It happens — but tap *"Fill in missed days"* right now while the week is still fresh 👀`;
      }

      // ── Date header ─────────────────────────────────────────────────────
      const monDay = monday.getUTCDate();
      const friDay = friday.getUTCDate();
      const monMonth = MONTHS[monday.getUTCMonth()];
      const friMonth = MONTHS[friday.getUTCMonth()];
      const dateRange =
        monMonth === friMonth
          ? `${monDay} — ${friDay} ${monMonth}`
          : `${monDay} ${monMonth} — ${friDay} ${friMonth}`;

      // ── Assemble the full message ────────────────────────────────────────
      let message = `📋 *Your week in review, ${user.firstName}*\n_${dateRange}_\n\n`;
      message += dayLines.join("\n");
      message += `\n\n_Logged *${loggedCount}/5* days this week_\n\n${motivationLine}`;

      if (quoteRow) {
        message += `\n\n——\n\n💬 *Advice from a former IT student*\n\n_"${quoteRow.quote}"_`;
        if (quoteRow.attribution) {
          message += `\n— ${quoteRow.attribution}`;
        }
      }

      // ── Inline keyboard — one button, text depends on completion ────────
      const keyboard: Array<Array<{ text: string; callback_data: string }>> =
        loggedCount === 5
          ? [[{ text: "📖 See my logs", callback_data: "weekly_nav_calendar" }]]
          : [[{ text: "📝 Fill in missed days", callback_data: "weekly_nav_past_log" }]];

      await bot.api.sendMessage(Number(user.telegramId), message, {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: keyboard },
      });

      sent++;
      console.log(`[weekly-recap] Sent recap to user ${user.id} (${loggedCount}/5 days logged)`);
    } catch (e: unknown) {
      const isBotBlocked =
        e instanceof Error && e.message.includes("bot was blocked by the user");

      if (isBotBlocked) {
        console.warn(`[weekly-recap] User ${user.id} blocked the bot — flagging`);
        await prisma.user.update({ where: { id: user.id }, data: { botBlocked: true } });
      } else {
        console.error(`[weekly-recap] Failed to send recap to user ${user.id}:`, e);
        captureReplayError(user.telegramId, e, "scheduler:weeklyRecap");
      }
      failed++;
    }
  }

  console.log(
    `[weekly-recap] Week ${weekNumber} complete — ${sent} sent, ${failed} failed (${users.length} total onboarded users)`,
  );
  return { sent, failed };
}

export function startScheduler(bot: Bot<BotContext>): void {
  // ── Re-entry locks — prevent overlapping async cron ticks ───────────────
  let reminderCronRunning = false;
  let autoSnoozeCronRunning = false;
  let onboardingNudgeCronRunning = false;
  let autoSaveCronRunning = false;
  let renewalCronRunning = false;
  let morningGreetingCronRunning = false;
  let afternoonGreetingCronRunning = false;

  // ── Split broadcast greetings ────────────────────────────────────────────
  // 8:00 AM job: send MORNING greetings to users whose previous greeting cycle
  // ended in AFTERNOON (flip-flop). First-week bootstrap: if there are still
  // zero MORNING users in the DB and no AFTERNOON candidates, seed 50% of
  // null-history users to preserve the staggered split.
  cron.schedule("0 8 * * *", async () => {
    if (morningGreetingCronRunning) {
      console.log("[scheduler] Morning greeting cron still running — skipping");
      return;
    }
    morningGreetingCronRunning = true;

    try {
      const startOfToday = getStartOfTodayInWAT();

      const totalDailyUsers = await prisma.user.count({
        where: {
          onboardingDone: true,
          botBlocked: false,
          logFrequency: "daily",
        },
      });

      if (totalDailyUsers === 0) return;

      const morningHistoryCount = await prisma.user.count({
        where: {
          onboardingDone: true,
          botBlocked: false,
          logFrequency: "daily",
          lastGreetingType: GreetingType.MORNING,
        },
      });

      const afternoonCandidates = await prisma.user.findMany({
        where: {
          onboardingDone: true,
          botBlocked: false,
          logFrequency: "daily",
          lastGreetingType: GreetingType.AFTERNOON,
          AND: [
            {
              OR: [{ lastGreetingSentAt: null }, { lastGreetingSentAt: { lt: startOfToday } }],
            },
          ],
        },
        select: { id: true, telegramId: true, lastGreetingType: true },
      });

      let usersToMessage = afternoonCandidates;
      let selectionPoolSize = afternoonCandidates.length;

      // Bootstrap exception: before MORNING history exists, if no AFTERNOON
      // candidates are available yet, seed half of null-history users.
      if (morningHistoryCount === 0 && afternoonCandidates.length === 0) {
        const bootstrapCandidates = await prisma.user.findMany({
          where: {
            onboardingDone: true,
            botBlocked: false,
            logFrequency: "daily",
            lastGreetingType: null,
            AND: [
              {
                OR: [{ lastGreetingSentAt: null }, { lastGreetingSentAt: { lt: startOfToday } }],
              },
            ],
          },
          select: { id: true, telegramId: true, lastGreetingType: true },
        });

        usersToMessage = pickRandomSubset(
          bootstrapCandidates,
          Math.floor(bootstrapCandidates.length / 2),
        );
        selectionPoolSize = bootstrapCandidates.length;
      }

      console.log(
        `[scheduler] Morning shift: ${usersToMessage.length}/${selectionPoolSize} users selected`,
      );

      for (const user of usersToMessage) {
        try {
          const claimedAt = new Date();
          const claim = await prisma.user.updateMany({
            where: {
              id: user.id,
              onboardingDone: true,
              botBlocked: false,
              logFrequency: "daily",
              OR: [
                { lastGreetingType: GreetingType.AFTERNOON },
                {
                  AND: [
                    { lastGreetingType: null },
                  ],
                },
              ],
              AND: [
                {
                  OR: [{ lastGreetingSentAt: null }, { lastGreetingSentAt: { lt: startOfToday } }],
                },
              ],
            },
            data: {
              lastGreetingSentAt: claimedAt,
              lastGreetingType: GreetingType.MORNING,
            },
          });

          if (claim.count === 0) {
            continue;
          }

          const text = pickRandomMessage(MORNING_GREETINGS);
          if (!text) continue;

          await bot.api.sendMessage(Number(user.telegramId), text, { parse_mode: "Markdown" });
        } catch (e: unknown) {
          const isBotBlocked = e instanceof Error && e.message.includes("bot was blocked by the user");
          if (isBotBlocked) {
            await prisma.user.update({ where: { id: user.id }, data: { botBlocked: true } });
          } else {
            console.error(`[scheduler] Morning greeting failed for user ${user.id}:`, e);
            captureReplayError(user.telegramId, e, "scheduler:morningGreeting");
          }
        }

        await delay(100);
      }
    } catch (err) {
      console.error("[scheduler] Morning greeting cron error:", err);
    } finally {
      morningGreetingCronRunning = false;
    }
  }, { timezone: BROADCAST_TIMEZONE });

  // 2:00 PM job: sweep users not greeted today and send AFTERNOON greetings.
  // Day-1/bootstrap safety: for null-history users, only send to 50% randomly.
  cron.schedule("0 14 * * *", async () => {
    if (afternoonGreetingCronRunning) {
      console.log("[scheduler] Afternoon greeting cron still running — skipping");
      return;
    }
    afternoonGreetingCronRunning = true;

    try {
      const startOfToday = getStartOfTodayInWAT();

      const candidates = await prisma.user.findMany({
        where: {
          onboardingDone: true,
          botBlocked: false,
          logFrequency: "daily",
          OR: [{ lastGreetingSentAt: null }, { lastGreetingSentAt: { lt: startOfToday } }],
        },
        select: { id: true, telegramId: true, lastGreetingSentAt: true },
      });

      const nullHistoryUsers = candidates.filter((u) => u.lastGreetingSentAt === null);
      const previouslyGreetedUsers = candidates.filter((u) => u.lastGreetingSentAt !== null);
      const nullHistorySelection = pickRandomSubset(
        nullHistoryUsers,
        Math.floor(nullHistoryUsers.length / 2),
      );

      const usersToMessage = [...previouslyGreetedUsers, ...nullHistorySelection];

      console.log(
        `[scheduler] Afternoon sweep: ${usersToMessage.length}/${candidates.length} daily users selected`,
      );

      for (const user of usersToMessage) {
        try {
          const claimedAt = new Date();
          const claim = await prisma.user.updateMany({
            where: {
              id: user.id,
              onboardingDone: true,
              botBlocked: false,
              logFrequency: "daily",
              OR: [{ lastGreetingSentAt: null }, { lastGreetingSentAt: { lt: startOfToday } }],
            },
            data: {
              lastGreetingSentAt: claimedAt,
              lastGreetingType: GreetingType.AFTERNOON,
            },
          });

          if (claim.count === 0) {
            continue;
          }

          const text = pickRandomMessage(MOTIVATIONAL_SHORTS);
          if (!text) continue;

          await bot.api.sendMessage(Number(user.telegramId), text, { parse_mode: "Markdown" });
        } catch (e: unknown) {
          const isBotBlocked = e instanceof Error && e.message.includes("bot was blocked by the user");
          if (isBotBlocked) {
            await prisma.user.update({ where: { id: user.id }, data: { botBlocked: true } });
          } else {
            console.error(`[scheduler] Afternoon greeting failed for user ${user.id}:`, e);
            captureReplayError(user.telegramId, e, "scheduler:afternoonGreeting");
          }
        }

        await delay(100);
      }
    } catch (err) {
      console.error("[scheduler] Afternoon greeting cron error:", err);
    } finally {
      afternoonGreetingCronRunning = false;
    }
  }, { timezone: BROADCAST_TIMEZONE });

  // ── 5.1 — Fire due reminders (every minute) ───────────────────────────────
  cron.schedule("* * * * *", async () => {
    if (reminderCronRunning) {
      console.log("[scheduler] Reminder cron still running from previous tick — skipping");
      return;
    }
    reminderCronRunning = true;

    try {
      // ── Sweeper: Recover orphaned jobs stuck in the atomic lock ────────
      const staleClaimCutoff = new Date(Date.now() - 10 * 60 * 1000);
      await prisma.reminderJob.updateMany({
        where: {
          status: "snoozed",
          autoNudgeCount: 0, // Ensures we don't accidentally revert actual user snoozes
          scheduledFor: { lte: staleClaimCutoff },
        },
        data: { status: "pending" },
      });

      const blockedUserIds = await prisma.user
        .findMany({ where: { botBlocked: true }, select: { id: true } })
        .then((rows) => rows.map((r) => r.id));

      const dueJobs = await prisma.reminderJob.findMany({
        where: {
          status: "pending",
          scheduledFor: { lte: new Date() },
          ...(blockedUserIds.length > 0 && { userId: { notIn: blockedUserIds } }),
        },
      });

      // ── Deduplicate: only process ONE job per user (the earliest) ────────
      const bestJobByUser = new Map<number, (typeof dueJobs)[0]>();
      const duplicateJobIds: number[] = [];

      for (const job of dueJobs) {
        const existing = bestJobByUser.get(job.userId);
        if (!existing || job.scheduledFor < existing.scheduledFor) {
          if (existing) duplicateJobIds.push(existing.id);
          bestJobByUser.set(job.userId, job);
        } else {
          duplicateJobIds.push(job.id);
        }
      }

      // Silently retire all duplicate due-jobs
      if (duplicateJobIds.length > 0) {
        await prisma.reminderJob.updateMany({
          where: { id: { in: duplicateJobIds } },
          data: { status: "skipped" },
        });
        console.log(`[scheduler] Retired ${duplicateJobIds.length} duplicate due jobs`);
      }

      for (const [, job] of bestJobByUser) {
        try {
          // ── Skip if today is a weekend (Sat/Sun) in user's timezone ──────
          // *UPDATED: We also fetch reminderTime here for the new getReminderMessage function
          const userForTz = await prisma.user.findUnique({
            where: { id: job.userId },
            select: {
              createdAt: true,
              timezone: true,
              reminderTime: true,
              lastGreetingSentAt: true,
              lastGreetingType: true,
            },
          });
          const userTz = userForTz?.timezone ?? "Africa/Lagos";

          // ── Skip if user already wrote a log today ───────────────────────
          const todayStart = localTimeToUtc("00:00", userTz, 0);
          const tomorrowStart = localTimeToUtc("00:00", userTz, 1);

          const todayLog = await prisma.log.findFirst({
            where: { userId: job.userId, logDate: { gte: todayStart, lt: tomorrowStart } },
          });

          if (todayLog) {
            // Already logged — silently retire this job and queue the next
            await prisma.reminderJob.update({ where: { id: job.id }, data: { status: "sent" } });
            await scheduleNextJob(job.userId, job.telegramId);
            console.log(`[scheduler] Skipped reminder for user ${job.userId} — already logged today`);
            continue;
          }

          const localDow = getLocalDayOfWeek(new Date(), userTz);
          if (localDow === 0 || localDow === 6) {
            await prisma.reminderJob.update({ where: { id: job.id }, data: { status: "skipped" } });
            await scheduleNextJob(job.userId, job.telegramId);
            console.log(`[scheduler] Skipped reminder for user ${job.userId} — weekend (${localDow === 6 ? "Sat" : "Sun"})`);
            continue;
          }

          // Prevent reminder collisions with the global 8AM/2PM greeting broadcasts.
          // If a MORNING/AFTERNOON greeting was sent in the last 4 hours, skip this
          // custom-time reminder and move the user to their next cycle.
          const fourHoursAgo = new Date(Date.now() - 4 * 60 * 60 * 1000);
          const recentlyGreeted = Boolean(
            userForTz?.lastGreetingSentAt
            && userForTz.lastGreetingSentAt >= fourHoursAgo
            && userForTz.lastGreetingType,
          );

          if (recentlyGreeted) {
            await prisma.reminderJob.update({ where: { id: job.id }, data: { status: "skipped" } });
            await scheduleNextJob(job.userId, job.telegramId);
            console.log(`[scheduler] Skipped reminder for user ${job.userId} — recent ${userForTz?.lastGreetingType} greeting within 4h`);
            continue;
          }

          // ── GHOST CHECK: Calculate days since last log or account creation ──
          const lastLog = await prisma.log.findFirst({
            where: { userId: job.userId },
            orderBy: { logDate: "desc" },
          });

          const nowTime = new Date();
          let daysSinceLastLog: number;

          if (lastLog) {
            daysSinceLastLog = differenceInDays(nowTime, lastLog.logDate);
          } else {
            // Fallback to account creation date if they have no logs yet
            daysSinceLastLog = userForTz?.createdAt
              ? differenceInDays(nowTime, userForTz.createdAt)
              : 0;
          }

          if (daysSinceLastLog > 14) {
            await prisma.reminderJob.update({
              where: { id: job.id },
              data: { status: "skipped" },
            });
            console.log(`[scheduler] Skipped reminder for user ${job.userId} — inactive for ${daysSinceLastLog} days`);
            continue;
          }

          // ── MARKETING STRATEGY: Get dynamic message & silence mode ───────
          const localHour = Number(
            new Intl.DateTimeFormat("en-US", {
              timeZone: userTz,
              hour: "2-digit",
              hour12: false,
            }).format(nowTime),
          );
          const { text, isSilent, bucket } = getReminderMessage(localHour, daysSinceLastLog);

          // Compute log date in user's timezone for the "Write my log" button
          const logDate = job.logDate
            ?? new Intl.DateTimeFormat("en-CA", { timeZone: userTz }).format(job.scheduledFor);

          const claim = await prisma.reminderJob.updateMany({
            where: { id: job.id, status: "pending" },
            data: { status: "snoozed" },
          });
          if (claim.count === 0) continue;

          try {
            await sendSceneViaApi(
              bot.api,
              Number(job.telegramId),
              "scene5",
              text, // Our new dynamic text
              {
                inline_keyboard: [
                  [{ text: "✍️ Write my log", callback_data: `write_log_${job.id}_${logDate}` }],
                  [{ text: "⏳ Remind me in 30 mins", callback_data: `snooze_${job.id}` }],
                  [{ text: "🙈 Skip today", callback_data: `skip_${job.id}` }],
                ],
              },
              isSilent // Passing the silence flag to our helper
            );

            // Store computed logDate on the job for auto-nudge messages later
            await prisma.reminderJob.update({
              where: { id: job.id },
              data: { status: "sent", logDate, bucketSent: bucket },
            });

            // Queue the next scheduled job (guard inside prevents duplicates)
            await scheduleNextJob(job.userId, job.telegramId);
          } catch (e: unknown) {
            await prisma.reminderJob.update({
              where: { id: job.id },
              data: { status: "pending" },
            });
            throw e;
          }
        } catch (e: unknown) {
          // If the user blocked the bot, mark them so and cancel all their pending jobs
          const isBotBlocked =
            e instanceof Error &&
            e.message.includes("bot was blocked by the user");

          if (isBotBlocked) {
            console.warn(`[scheduler] User ${job.userId} blocked the bot — disabling reminders`);
            try {
              await prisma.user.update({
                where: { id: job.userId },
                data: { botBlocked: true },
              });
              await prisma.reminderJob.updateMany({
                where: { userId: job.userId, status: { in: ["pending", "snoozed"] } },
                data: { status: "skipped" },
              });
            } catch (dbErr) {
              console.error("[scheduler] Failed to persist botBlocked state:", dbErr);
            }
          } else {
            console.error(`[scheduler] Failed to send reminder for job ${job.id}:`, e);
            captureReplayError(job.telegramId, e, "scheduler:sendReminder");
          }
        }
      }
    } catch (err) {
      console.error("[scheduler] Reminder cron error:", err);
    } finally {
      reminderCronRunning = false;
    }
  });

  // ── 5.4 — Auto-nudge: send follow-up reminders when user ignores (every 5 min)
  //
  // Design: If a reminder was sent and the user hasn't interacted (status stays
  // "sent"), we send up to 3 follow-up nudges at 30-minute intervals. We track
  // the count via `autoNudgeCount` on the original job — NO new jobs are
  // created, which avoids the duplicate-job issues we had previously.
  //
  // Auto-nudge STOPS if the user interacts (snooze/skip/write changes status
  // away from "sent", or sets autoNudgeCount = 3).
  // ---------------------------------------------------------------------------

  const AUTO_NUDGE_MESSAGES = [
    // Nudge 1 — gentle
    `Hey! 👋 Just checking in — haven't heard from you yet. Ready to write your log?`,
    // Nudge 2 — moderate
    `Still there? 😊 Your logbook is waiting. Even a few sentences is better than nothing!`,
    // Nudge 3 — final
    `Last nudge for today! 😅 Just write something quick — your future self will thank you 🙏`,
  ];

  cron.schedule("*/5 * * * *", async () => {
    if (autoSnoozeCronRunning) {
      console.log("[scheduler] Auto-nudge cron still running from previous tick — skipping");
      return;
    }
    autoSnoozeCronRunning = true;

    try {
      const now = new Date();

      // Find "sent" jobs that still have auto-nudges remaining
      const blockedUserIdsForNudge = await prisma.user
        .findMany({ where: { botBlocked: true }, select: { id: true } })
        .then((rows) => rows.map((r) => r.id));

      const sentJobs = await prisma.reminderJob.findMany({
        where: {
          status: "sent",
          autoNudgeCount: { lt: 3 },
          ...(blockedUserIdsForNudge.length > 0 && { userId: { notIn: blockedUserIdsForNudge } }),
        },
      });

      // ── Deduplicate: only process ONE sent job per user (the latest) ─────
      const bestSentByUser = new Map<number, (typeof sentJobs)[0]>();
      const extraSentIds: number[] = [];

      for (const job of sentJobs) {
        const existing = bestSentByUser.get(job.userId);
        if (!existing || job.scheduledFor > existing.scheduledFor) {
          if (existing) extraSentIds.push(existing.id);
          bestSentByUser.set(job.userId, job);
        } else {
          extraSentIds.push(job.id);
        }
      }

      // Retire duplicate sent jobs
      if (extraSentIds.length > 0) {
        await prisma.reminderJob.updateMany({
          where: { id: { in: extraSentIds } },
          data: { status: "snoozed", autoNudgeCount: 3 },
        });
        console.log(`[scheduler] Retired ${extraSentIds.length} duplicate sent jobs`);
      }

      for (const [, job] of bestSentByUser) {
        try {
          // Timing check: is the next nudge due?
          // Nudge N fires at scheduledFor + (N+1)*20 minutes
          const nextNudgeAt = new Date(
            job.scheduledFor.getTime() + (job.autoNudgeCount + 1) * 20 * 60 * 1000,
          );
          if (now < nextNudgeAt) continue; // not yet time for the next nudge

          // Re-check job status (might have changed since initial query)
          const freshJob = await prisma.reminderJob.findUnique({ where: { id: job.id } });
          if (!freshJob || freshJob.status !== "sent" || freshJob.autoNudgeCount >= 3) continue;

          // ── Skip if user already wrote a log today ───────────────────────
          const userForTz = await prisma.user.findUnique({
            where: { id: freshJob.userId },
            select: { timezone: true },
          });
          const userTz = userForTz?.timezone ?? "Africa/Lagos";

          const todayStart = localTimeToUtc("00:00", userTz, 0);
          const tomorrowStart = localTimeToUtc("00:00", userTz, 1);

          const todayLog = await prisma.log.findFirst({
            where: { userId: freshJob.userId, logDate: { gte: todayStart, lt: tomorrowStart } },
          });

          if (todayLog) {
            await prisma.reminderJob.update({
              where: { id: freshJob.id },
              data: { autoNudgeCount: 3 },
            });
            console.log(`[scheduler] Skipped auto-nudge for user ${freshJob.userId} — already logged today`);
            continue;
          }

          const nudgeIndex = freshJob.autoNudgeCount; // 0, 1, or 2
          const nudgeMessage = AUTO_NUDGE_MESSAGES[nudgeIndex];
          const logDate = freshJob.logDate
            ?? new Intl.DateTimeFormat("en-CA").format(freshJob.scheduledFor);

          if (nudgeIndex === 2) {
            // Final nudge — use Scene 6 for visual emphasis
            await sendSceneViaApi(
              bot.api,
              Number(freshJob.telegramId),
              "scene6",
              nudgeMessage,
              {
                inline_keyboard: [
                  [{ text: "✍️ Write my log", callback_data: `write_log_${freshJob.id}_${logDate}` }],
                  [{ text: "🙈 Skip today", callback_data: `skip_${freshJob.id}` }],
                ],
              },
            );
          } else {
            // Nudge 1 & 2 — plain text (less intrusive than a photo)
            await bot.api.sendMessage(
              Number(freshJob.telegramId),
              nudgeMessage,
              {
                reply_markup: {
                  inline_keyboard: [
                    [{ text: "✍️ Write my log", callback_data: `write_log_${freshJob.id}_${logDate}` }],
                    [{ text: "🙈 Skip today", callback_data: `skip_${freshJob.id}` }],
                  ],
                },
              },
            );
          }

          // Increment auto-nudge count; retire job after the 3rd nudge
          const newAutoNudgeCount = freshJob.autoNudgeCount + 1;
          await prisma.reminderJob.update({
            where: { id: freshJob.id },
            data: {
              autoNudgeCount: newAutoNudgeCount,
              ...(newAutoNudgeCount >= 3 && { status: "skipped" }),
            },
          });

          console.log(
            `[scheduler] Auto-nudge #${newAutoNudgeCount} sent for user ${freshJob.userId} (job ${freshJob.id})`,
          );
        } catch (e: unknown) {
          const isBotBlocked =
            e instanceof Error &&
            e.message.includes("bot was blocked by the user");

          if (isBotBlocked) {
            console.warn(`[scheduler] User ${job.userId} blocked the bot — disabling reminders (auto-nudge)`);
            await prisma.user.update({
              where: { id: job.userId },
              data: { botBlocked: true },
            });
            await prisma.reminderJob.updateMany({
              where: { userId: job.userId, status: { in: ["pending", "snoozed"] } },
              data: { status: "skipped" },
            });
          } else {
            console.error(`[scheduler] Auto-nudge failed for job ${job.id}:`, e);
            captureReplayError(job.telegramId, e, "scheduler:autoNudge");
          }
        }
      }

    } catch (err) {
      console.error("[scheduler] Auto-nudge cron error:", err);
    } finally {
      autoSnoozeCronRunning = false;
    }
  });

  // ── Onboarding nudge — 8 pm WAT (19:00 UTC) daily ───────────────────────
  cron.schedule("0 19 * * *", async () => {
    if (onboardingNudgeCronRunning) {
      console.log("[scheduler] Onboarding nudge cron still running — skipping");
      return;
    }
    onboardingNudgeCronRunning = true;

    try {
      const incompleteUsers = await prisma.user.findMany({
        where: { onboardingDone: false, botBlocked: false },
        select: { telegramId: true, firstName: true, id: true },
      });

      console.log(`[scheduler] Sending onboarding nudge to ${incompleteUsers.length} user(s)`);

      for (const user of incompleteUsers) {
        try {
          await bot.api.sendMessage(
            Number(user.telegramId),
            `hey ${user.firstName} 👋\nyou started setting up your Wisa but never finished 😅\n\nwhich means right now you have not started taking your logs and your IT days are already going by 👀\n\nit'll take you about 20 seconds to finish. literally just pick how often you want to log and what time you want to be reminded. that's it.\n\nafter that the bot handles everything 🙏`,
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: "Finish my setup ✅", callback_data: "start_onboarding" }],
                ],
              },
            },
          );
        } catch (e: unknown) {
          const isBotBlocked =
            e instanceof Error &&
            e.message.includes("bot was blocked by the user");

          if (isBotBlocked) {
            console.warn(`[scheduler] User ${user.id} blocked the bot — flagging (onboarding nudge)`);
            await prisma.user.update({
              where: { id: user.id },
              data: { botBlocked: true },
            });
          } else {
            console.error(`[scheduler] Failed to send onboarding nudge to ${user.telegramId}:`, e);
          }
        }
      }
    } catch (err) {
      console.error("[scheduler] Onboarding nudge cron error:", err);
    } finally {
      onboardingNudgeCronRunning = false;
    }
  });

  // ── Storage renewal reminder + lapse lock — 8 PM Lagos (19:00 UTC) ─────
  cron.schedule("0 19 * * *", async () => {
    if (renewalCronRunning) {
      console.log("[scheduler] Renewal cron still running — skipping");
      return;
    }
    renewalCronRunning = true;

    try {
      const lagosToday = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Africa/Lagos",
      }).format(new Date());

      const yesterday = new Date();
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);
      const lagosYesterday = new Intl.DateTimeFormat("en-CA", {
        timeZone: "Africa/Lagos",
      }).format(yesterday);

      const renewalCandidates = await prisma.user.findMany({
        where: {
          onboardingDone: true,
          botBlocked: false,
          nextRenewalDate: { not: null },
        },
        select: {
          id: true,
          telegramId: true,
          firstName: true,
          storageUnlocked: true,
          nextRenewalDate: true,
          logCount: true,
        },
      });

      for (const user of renewalCandidates) {
        const renewalDate = user.nextRenewalDate;
        if (!renewalDate) continue;
        const renewalLocalDate = new Intl.DateTimeFormat("en-CA", {
          timeZone: "Africa/Lagos",
        }).format(renewalDate);

        if (user.storageUnlocked && renewalLocalDate === lagosToday) {
          await bot.api.sendMessage(
            Number(user.telegramId),
            `Hey ${user.firstName} 👋\n\n` +
              `Your Wisa storage renews today - just ₦1,000 to keep everything going for another month 🗓️\n\n` +
              `Your ${user.logCount || ""} logs are still safe. Just tap below to keep the streak alive 🙏`,
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: "🔓 Renew - ₦1,000", callback_data: "go_pro" }]                ],
              },
            },
          ).catch(() => {});
          continue;
        }

        if (user.storageUnlocked && renewalLocalDate === lagosYesterday) {
          await prisma.user.update({
            where: { id: user.id },
            data: { storageUnlocked: false, isPro: false },
          });

          await bot.api.sendMessage(
            Number(user.telegramId),
            `📦 Hey ${user.firstName}, just a reminder - your Wisa storage expired yesterday.\n\n` +
              `Your logs are all still there and readable. But new ones can't be saved until you renew 🙏\n\n` +
              `₦1,000 gets you another full month.`,
            {
              reply_markup: {
                inline_keyboard: [[{ text: "🔓 Renew now", callback_data: "go_pro" }]],
              },
            },
          ).catch(() => {});
        }
      }
    } catch (err) {
      console.error("[scheduler] Renewal cron error:", err);
    } finally {
      renewalCronRunning = false;
    }
  });

  // ── Replay event cleanup — runs daily at 3:00 AM ──────────────────────────
  cron.schedule("0 3 * * *", async () => {
    try {
      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const result = await prisma.replayEvent.deleteMany({
        where: { timestamp: { lt: cutoff } },
      });
      if (result.count > 0) {
        console.log(
          `[scheduler] Cleaned up ${result.count} replay events older than 30 days`,
        );
      }
    } catch (err) {
      console.error("[scheduler] Failed to clean up replay events:", err);
    }
  });

  // ── Auto-save: rescue unfinished log-writing sessions (every 5 min) ───────
  //
  // When a user starts writing a log and then goes idle, their draft can get
  // stuck in the session. This cron reads
  // all Session rows from the DB, finds ones with pending log parts that have
  // gone idle, and either:
  //   - After 15 min idle: sends a prompt asking to save or keep writing
  //   - After 30 min idle (15 min after prompt): auto-saves the log
  // ---------------------------------------------------------------------------

  const IDLE_PROMPT_MS = 15 * 60 * 1000;    // 15 minutes
  const IDLE_AUTOSAVE_MS = 30 * 60 * 1000;  // 30 minutes total

  cron.schedule("*/5 * * * *", async () => {
    if (autoSaveCronRunning) return;
    autoSaveCronRunning = true;

    try {
      const allSessions = await prisma.session.findMany();
      const now = Date.now();

      for (const row of allSessions) {
        try {
          const session: SessionData = JSON.parse(row.value);

          // Only care about sessions actively writing a log with actual content
          if (!session.awaitingLog || !session.pendingLogParts?.length) continue;

          // Need a lastLogMessageAt timestamp to measure idle time
          const lastActivity = session.lastLogMessageAt;
          if (!lastActivity) continue;

          const idleMs = now - lastActivity;
          const chatId = parseInt(row.key, 10);
          if (isNaN(chatId)) continue;

          // ── Stage 2: Auto-save after 30 min total idle ────────────────
          if (session.autoSavePromptSent && idleMs >= IDLE_AUTOSAVE_MS) {
            // Look up the DB user
            const dbUser = await prisma.user.findUnique({
              where: { telegramId: BigInt(chatId) },
            });
            if (!dbUser) continue;

            if (!canCreateLog(dbUser)) {
              await bot.api.sendMessage(
                chatId,
                getStorageWallText(dbUser),
                {
                  parse_mode: "Markdown",
                  reply_markup: {
                    inline_keyboard: [[{ text: "🔓 Unlock storage - ₦1,000", callback_data: "go_pro" }]],
                  },
                },
              ).catch(() => {});

              session.awaitingLog = false;
              session.pendingLogParts = [];
              session.pendingLogDate = undefined;
              session.flowStartedAt = undefined;
              session.lastLogMessageAt = undefined;
              session.autoSavePromptSent = undefined;

              await prisma.session.update({
                where: { id: row.id },
                data: { value: JSON.stringify(session) },
              });

              continue;
            }

            const fullText = session.pendingLogParts.join("\n\n").trim();
            if (!fullText) continue;

            const logDate = session.pendingLogDate
              ? parseISO(session.pendingLogDate)
              : new Date();

            const [savedLog, updatedUser] = await prisma.$transaction([
              prisma.log.create({
                data: {
                  userId: dbUser.id,
                  content: fullText,
                  logDate,
                  isVoice: false,
                  isAiRefined: false,
                },
              }),
              prisma.user.update({
                where: { id: dbUser.id },
                data: { logCount: { increment: 1 } },
                select: {
                  id: true,
                  firstName: true,
                  isPro: true,
                  storageUnlocked: true,
                  logCount: true,
                  nextRenewalDate: true,
                },
              }),
            ]);

            console.log(
              `[auto-save] Saved log #${savedLog.id} for user ${dbUser.id} (${fullText.split(/\s+/).length} words, idle ${Math.round(idleMs / 60000)}m)`,
            );

            // Clear the session
            session.awaitingLog = false;
            session.pendingLogParts = [];
            session.pendingLogDate = undefined;
            session.flowStartedAt = undefined;
            session.lastLogMessageAt = undefined;
            session.autoSavePromptSent = undefined;

            await prisma.session.update({
              where: { id: row.id },
              data: { value: JSON.stringify(session) },
            });

            // Notify the user
            try {
              await bot.api.sendMessage(
                chatId,
                `✅ I went ahead and saved your log because it looked like you were done.\n\n📖 ${fullText.length > 150 ? fullText.slice(0, 150) + "…" : fullText}\n\nYou can always edit it later from your calendar 📅`,
                {
                  reply_markup: {
                    inline_keyboard: [
                      [{ text: "✨ Refine with AI", callback_data: `ai_refine_${savedLog.id}` }],
                      [
                        { text: "📖 View logs", callback_data: "nav_calendar" },
                        { text: "🏠 Menu", callback_data: "nav_menu" },
                      ],
                    ],
                  },
                },
              );

              if (!hasActiveStorage(updatedUser) && updatedUser.logCount === FREE_LOG_LIMIT) {
                await bot.api.sendMessage(chatId, getStorageLimitReachedAfterSaveText(), {
                  parse_mode: "Markdown",
                  reply_markup: {
                    inline_keyboard: [[{ text: "🔓 Unlock storage - ₦1,000", callback_data: "go_pro" }]],
                  },
                });
              }
            } catch (sendErr) {
              console.error(`[auto-save] Failed to notify chat ${chatId}:`, sendErr);
            }

            continue;
          }

          // ── Stage 1: Prompt after 15 min idle ─────────────────────────
          if (!session.autoSavePromptSent && idleMs >= IDLE_PROMPT_MS) {
            session.autoSavePromptSent = true;

            await prisma.session.update({
              where: { id: row.id },
              data: { value: JSON.stringify(session) },
            });

            const wordCount = session.pendingLogParts.join(" ").split(/\s+/).filter(Boolean).length;

            try {
              await bot.api.sendMessage(
                chatId,
                `Hey! 👋 Looks like you stopped writing.\n\nI've got *${wordCount} word${wordCount === 1 ? "" : "s"}* so far. Want me to save it, or are you still going?`,
                {
                  parse_mode: "Markdown",
                  reply_markup: {
                    inline_keyboard: [
                      [{ text: "💾 Save it", callback_data: "auto_save_confirm" }],
                      [{ text: "✏️ I'm still writing", callback_data: "auto_save_continue" }],
                    ],
                  },
                },
              );
            } catch (sendErr) {
              console.error(`[auto-save] Failed to prompt chat ${chatId}:`, sendErr);
            }
          }
        } catch (parseErr) {
          // Corrupt session row — skip
          continue;
        }
      }
    } catch (err) {
      console.error("[scheduler] Auto-save cron error:", err);
    } finally {
      autoSaveCronRunning = false;
    }
  });

  // ── Saturday Weekly Recap — 12PM WAT = 11:00 UTC (0 11 * * 6) ──────────
  let weeklyRecapCronRunning = false;

  cron.schedule("0 11 * * 6", async () => {
    if (weeklyRecapCronRunning) {
      console.log("[scheduler] Weekly recap cron still running from previous tick — skipping");
      return;
    }
    weeklyRecapCronRunning = true;
    try {
      await sendWeeklyRecap(bot);
    } catch (err) {
      console.error("[scheduler] Weekly recap cron error:", err);
    } finally {
      weeklyRecapCronRunning = false;
    }
  });

  console.log("[scheduler] Reminder cron jobs started.");
}