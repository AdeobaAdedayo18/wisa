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

function isBotBlockedError(e: unknown): boolean {
  return e instanceof Error && e.message.includes("bot was blocked by the user");
}

async function markUserBlockedAndSkipPendingJobs(userId: number): Promise<void> {
  await prisma.user.update({ where: { id: userId }, data: { botBlocked: true } });
  await prisma.reminderJob.updateMany({
    where: { userId, status: { in: ["pending", "snoozed"] } },
    data: { status: "skipped" },
  });
}

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
// THE HEALER: Restores lost reminder jobs (Optimized Bulk Query)
// ---------------------------------------------------------------------------
async function healMissingJobs() {
  try {
    console.log("[scheduler] Running Job Healer... checking for dropped users 👀");
    const users = await prisma.user.findMany({
      where: { onboardingDone: true, botBlocked: false },
      select: { id: true, telegramId: true }
    });

    if (users.length === 0) return;

    // Bulk fetch all active reminder jobs and build a set of userIds that are covered
    const activeJobs = await prisma.reminderJob.findMany({
      where: { status: { in: ["pending", "snoozed", "sent"] } },
      select: { userId: true }
    });
    const activeSet = new Set(activeJobs.map((a) => a.userId));

    const toRestore = users.filter((u) => !activeSet.has(u.id));
    if (toRestore.length === 0) {
      console.log("[scheduler] All users are safely in the reminder loop.");
      return;
    }

    let restoredCount = 0;
    for (const u of toRestore) {
      try {
        await scheduleNextJob(u.id, u.telegramId);
        restoredCount++;
      } catch (e) {
        console.error("[scheduler] Healer failed to schedule for", u.id, e);
      }
      // small throttle to avoid connection spikes
      await delay(20);
    }

    console.log(`[scheduler] ✨ HEALER SUCCESS: Restored missing reminder jobs for ${restoredCount} users!`);
  } catch (e) {
    console.error("[scheduler] Healer error:", e);
  }
}

// ---------------------------------------------------------------------------
// Weekly Recap
// ---------------------------------------------------------------------------
export async function sendWeeklyRecap(bot: Bot<BotContext>): Promise<{ sent: number; failed: number }> {
  const now = new Date();
  const utcDay = now.getUTCDay();
  const daysToMon = (utcDay - 1 + 7) % 7;

  const monday = new Date(now);
  monday.setUTCDate(monday.getUTCDate() - daysToMon);
  monday.setUTCHours(0, 0, 0, 0);

  const friday = new Date(monday);
  friday.setUTCDate(friday.getUTCDate() + 4);
  friday.setUTCHours(23, 59, 59, 999);

  const itStartIso = process.env.IT_START_DATE ?? "2026-03-02";
  const itStartDate = new Date(`${itStartIso}T00:00:00.000Z`);
  const diffMs = monday.getTime() - itStartDate.getTime();
  const weekNumber = Math.max(1, Math.floor(diffMs / (7 * 24 * 60 * 60 * 1000)) + 1);

  const totalQuotes = await prisma.weeklyQuote.count();
  let quoteRow: { quote: string; attribution: string | null } | null = null;

  if (totalQuotes > 0) {
    const cycledWeek = ((weekNumber - 1) % totalQuotes) + 1;
    quoteRow = await prisma.weeklyQuote.findFirst({
      where: { weekNumber: cycledWeek },
      select: { quote: true, attribution: true },
    });
    if (!quoteRow) {
      quoteRow = await prisma.weeklyQuote.findFirst({
        orderBy: { weekNumber: "asc" },
        select: { quote: true, attribution: true },
      });
    }
  }

  const users = await prisma.user.findMany({
    where: { onboardingDone: true, botBlocked: false },
    select: { id: true, telegramId: true, firstName: true },
  });

  const allLogs = await prisma.log.findMany({
    where: {
      userId: { in: users.map((u) => u.id) },
      logDate: { gte: monday, lte: friday }
    },
    select: { userId: true, logDate: true, content: true },
    orderBy: { logDate: "asc" }
  });

  const logsByUserId = new Map<number, typeof allLogs>();
  for (const log of allLogs) {
    if (!logsByUserId.has(log.userId)) logsByUserId.set(log.userId, []);
    logsByUserId.get(log.userId)!.push(log);
  }

  const DAYS = ["Monday", "Tuesday", "Wednesday", "Thursday", "Friday"];
  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  let sent = 0;
  let failed = 0;

  for (const user of users) {
    try {
      const userLogs = logsByUserId.get(user.id) || [];
      const logsByDay = new Map<number, string>();
      
      for (const log of userLogs) {
        const offsetMs = log.logDate.getTime() - monday.getTime();
        const dayOffset = Math.round(offsetMs / (24 * 60 * 60 * 1000));
        if (dayOffset >= 0 && dayOffset <= 4) {
          logsByDay.set(dayOffset, log.content);
        }
      }

      const loggedCount = logsByDay.size;
      if (loggedCount === 0) continue;

      const dayLines = DAYS.map((day, i) => {
        const content = logsByDay.get(i);
        if (content) {
          const preview = content.length > 100 ? content.slice(0, 100).trimEnd() + "…" : content;
          return `${day} — ${preview} 📝`;
        }
        return `${day} — nothing logged that day 👀`;
      });

      let motivationLine: string;
      if (loggedCount === 5) {
        motivationLine = "You logged every single day this week 🔥 Your logbook is going to be immaculate.";
      } else if (loggedCount >= 3) {
        motivationLine = `Solid week! The missed days can still be filled in — tap *"Fill in missed days"* and catch up before you forget 🙏`;
      } else if (loggedCount >= 1) {
        motivationLine = `This week was rough — no judgement 😅 But go fill in what you remember before the details fade. Future you needs this.`;
      } else {
        motivationLine = `No logs this week, ${user.firstName}. It happens — but tap *"Fill in missed days"* right now while the week is still fresh 👀`;
      }

      const monDay = monday.getUTCDate();
      const friDay = friday.getUTCDate();
      const monMonth = MONTHS[monday.getUTCMonth()];
      const friMonth = MONTHS[friday.getUTCMonth()];
      const dateRange = monMonth === friMonth
        ? `${monDay} — ${friDay} ${monMonth}`
        : `${monDay} ${monMonth} — ${friDay} ${friMonth}`;

      let message = `📋 *Your week in review, ${user.firstName}*\n_${dateRange}_\n\n`;
      message += dayLines.join("\n");
      message += `\n\n_Logged *${loggedCount}/5* days this week_\n\n${motivationLine}`;

      if (quoteRow) {
        message += `\n\n——\n\n💬 *Advice from a former IT student*\n\n_"${quoteRow.quote}"_`;
        if (quoteRow.attribution) {
          message += `\n— ${quoteRow.attribution}`;
        }
      }

      const keyboard: Array<Array<{ text: string; callback_data: string }>> =
        loggedCount === 5
          ? [[{ text: "📖 See my logs", callback_data: "weekly_nav_calendar" }]]
          : [[{ text: "📝 Fill in missed days", callback_data: "weekly_nav_past_log" }]];

      await bot.api.sendMessage(Number(user.telegramId), message, {
        parse_mode: "Markdown",
        reply_markup: { inline_keyboard: keyboard },
      });

      sent++;
    } catch (e: unknown) {
      if (isBotBlockedError(e)) {
        await markUserBlockedAndSkipPendingJobs(user.id);
      } else {
        console.error(`[weekly-recap] Failed to send recap to user ${user.id}:`, e);
      }
      failed++;
    }
  }

  console.log(`[weekly-recap] Week ${weekNumber} complete — ${sent} sent, ${failed} failed`);
  return { sent, failed };
}

export function startScheduler(bot: Bot<BotContext>): void {
  healMissingJobs();

  let reminderCronRunning = false;
  let autoSnoozeCronRunning = false;
  let onboardingNudgeCronRunning = false;
  let autoSaveCronRunning = false;
  let renewalCronRunning = false;
  let morningGreetingCronRunning = false;
  let afternoonGreetingCronRunning = false;

  // ── Morning Greeting ──
  cron.schedule("0 8 * * *", async () => {
    if (morningGreetingCronRunning) return;
    morningGreetingCronRunning = true;

    try {
      const dayOfWeek = new Date().getDay();
      if (dayOfWeek === 0 || dayOfWeek === 6) return;

      const startOfToday = getStartOfTodayInWAT();
      
      const totalDailyUsers = await prisma.user.count({
        where: { onboardingDone: true, botBlocked: false, logFrequency: "daily" },
      });
      if (totalDailyUsers === 0) return;

      const morningHistoryCount = await prisma.user.count({
        where: { onboardingDone: true, botBlocked: false, logFrequency: "daily", lastGreetingType: GreetingType.MORNING },
      });

      const afternoonCandidates = await prisma.user.findMany({
        where: {
          onboardingDone: true, botBlocked: false, logFrequency: "daily",
          lastGreetingType: GreetingType.AFTERNOON,
          AND: [{ OR: [{ lastGreetingSentAt: null }, { lastGreetingSentAt: { lt: startOfToday } }] }],
        },
        select: { id: true, telegramId: true, lastGreetingType: true },
      });

      let usersToMessage = afternoonCandidates;

      if (morningHistoryCount === 0 && afternoonCandidates.length === 0) {
        const bootstrapCandidates = await prisma.user.findMany({
          where: {
            onboardingDone: true, botBlocked: false, logFrequency: "daily", lastGreetingType: null,
            AND: [{ OR: [{ lastGreetingSentAt: null }, { lastGreetingSentAt: { lt: startOfToday } }] }],
          },
          select: { id: true, telegramId: true, lastGreetingType: true },
        });
        usersToMessage = pickRandomSubset(bootstrapCandidates, Math.floor(bootstrapCandidates.length / 2));
      }

      for (const user of usersToMessage) {
        try {
          const claimedAt = new Date();
          const claim = await prisma.user.updateMany({
            where: {
              id: user.id, onboardingDone: true, botBlocked: false, logFrequency: "daily",
              OR: [{ lastGreetingType: GreetingType.AFTERNOON }, { AND: [{ lastGreetingType: null }] }],
              AND: [{ OR: [{ lastGreetingSentAt: null }, { lastGreetingSentAt: { lt: startOfToday } }] }],
            },
            data: { lastGreetingSentAt: claimedAt, lastGreetingType: GreetingType.MORNING },
          });

          if (claim.count === 0) continue;

          const text = pickRandomMessage(MORNING_GREETINGS);
          if (!text) continue;

          await bot.api.sendMessage(Number(user.telegramId), text, { parse_mode: "Markdown" });
        } catch (e: unknown) {
          if (isBotBlockedError(e)) {
            await markUserBlockedAndSkipPendingJobs(user.id);
          } else {
            console.error(`[scheduler] Morning greeting failed for user ${user.id}:`, e);
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

  // ── Afternoon Greeting ──
  cron.schedule("0 14 * * *", async () => {
    if (afternoonGreetingCronRunning) return;
    afternoonGreetingCronRunning = true;

    try {
      const dayOfWeek = new Date().getDay();
      if (dayOfWeek === 0 || dayOfWeek === 6) return;
      
      const startOfToday = getStartOfTodayInWAT();
      
      const candidates = await prisma.user.findMany({
        where: {
          onboardingDone: true, botBlocked: false, logFrequency: "daily",
          OR: [{ lastGreetingSentAt: null }, { lastGreetingSentAt: { lt: startOfToday } }],
        },
        select: { id: true, telegramId: true, lastGreetingSentAt: true },
      });

      const nullHistoryUsers = candidates.filter((u) => u.lastGreetingSentAt === null);
      const previouslyGreetedUsers = candidates.filter((u) => u.lastGreetingSentAt !== null);
      const nullHistorySelection = pickRandomSubset(nullHistoryUsers, Math.floor(nullHistoryUsers.length / 2));

      const usersToMessage = [...previouslyGreetedUsers, ...nullHistorySelection];

      for (const user of usersToMessage) {
        try {
          const claimedAt = new Date();
          const claim = await prisma.user.updateMany({
            where: {
              id: user.id, onboardingDone: true, botBlocked: false, logFrequency: "daily",
              OR: [{ lastGreetingSentAt: null }, { lastGreetingSentAt: { lt: startOfToday } }],
            },
            data: { lastGreetingSentAt: claimedAt, lastGreetingType: GreetingType.AFTERNOON },
          });

          if (claim.count === 0) continue;

          const text = pickRandomMessage(MOTIVATIONAL_SHORTS);
          if (!text) continue;

          await bot.api.sendMessage(Number(user.telegramId), text, { parse_mode: "Markdown" });
        } catch (e: unknown) {
          if (isBotBlockedError(e)) {
            await markUserBlockedAndSkipPendingJobs(user.id);
          } else {
            console.error(`[scheduler] Afternoon greeting failed for user ${user.id}:`, e);
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

  // ── Due Reminders (every minute) ──
  cron.schedule("* * * * *", async () => {
    if (reminderCronRunning) return;
    reminderCronRunning = true;

    try {
      const staleClaimCutoff = new Date(Date.now() - 10 * 60 * 1000);
      await prisma.reminderJob.updateMany({
        where: { status: "snoozed", autoNudgeCount: 0, scheduledFor: { lte: staleClaimCutoff } },
        data: { status: "pending" },
      });

      const dueJobs = await prisma.reminderJob.findMany({
        where: {
          status: "pending",
          scheduledFor: { lte: new Date() },
          user: { botBlocked: false }
        },
        include: { user: true }
      });

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

      if (duplicateJobIds.length > 0) {
        await prisma.reminderJob.updateMany({
          where: { id: { in: duplicateJobIds } },
          data: { status: "skipped" },
        });
      }

      const userIds = Array.from(bestJobByUser.keys());
      const latestLogs = await prisma.log.findMany({
        where: { userId: { in: userIds } },
        orderBy: { logDate: "desc" },
        distinct: ['userId'],
      });
      const latestLogMap = new Map(latestLogs.map((l) => [l.userId, l]));

      for (const [, job] of bestJobByUser) {
        try {
          const userForTz = job.user; 
          if (!userForTz) continue; 
          
          const userTz = userForTz.timezone ?? "Africa/Lagos";
          const todayStart = localTimeToUtc("00:00", userTz, 0);
          const tomorrowStart = localTimeToUtc("00:00", userTz, 1);
          
          const lastLog = latestLogMap.get(job.userId);
          const alreadyLoggedToday = lastLog && lastLog.logDate >= todayStart && lastLog.logDate < tomorrowStart;

          if (alreadyLoggedToday) {
            await prisma.reminderJob.update({ where: { id: job.id }, data: { status: "sent" } });
            await scheduleNextJob(job.userId, job.telegramId);
            continue;
          }

          const localDow = getLocalDayOfWeek(new Date(), userTz);
          if (localDow === 0 || localDow === 6) {
            await prisma.reminderJob.update({ where: { id: job.id }, data: { status: "skipped" } });
            await scheduleNextJob(job.userId, job.telegramId);
            continue;
          }

          const nowTime = new Date();
          let daysSinceLastLog = lastLog 
            ? differenceInDays(nowTime, lastLog.logDate)
            : (userForTz.createdAt ? differenceInDays(nowTime, userForTz.createdAt) : 0);

          if (daysSinceLastLog > 14) {
            await prisma.reminderJob.update({ where: { id: job.id }, data: { status: "skipped" } });
            continue;
          }

          const localHour = Number(new Intl.DateTimeFormat("en-US", { timeZone: userTz, hour: "2-digit", hour12: false }).format(nowTime));
          const { text, isSilent, bucket } = getReminderMessage(localHour, daysSinceLastLog);
          const logDate = job.logDate ?? new Intl.DateTimeFormat("en-CA", { timeZone: userTz }).format(job.scheduledFor);

          // Atomic Claim
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
              text, 
              { inline_keyboard: [
                  [{ text: "✍️ Write my log", callback_data: `write_log_${job.id}_${logDate}` }],
                  [{ text: "⏳ Remind me in 30 mins", callback_data: `snooze_${job.id}` }],
                  [{ text: "🙈 Skip today", callback_data: `skip_${job.id}` }],
                ]
              },
              isSilent 
            );

            await prisma.reminderJob.update({
              where: { id: job.id },
              data: { status: "sent", logDate, bucketSent: bucket },
            });

            await scheduleNextJob(job.userId, job.telegramId);
          } catch (e: unknown) {
            await prisma.reminderJob.update({ where: { id: job.id }, data: { status: "pending" } });
            throw e;
          }
        } catch (e: unknown) {
          if (isBotBlockedError(e)) {
            await markUserBlockedAndSkipPendingJobs(job.userId);
          } else {
            console.error(`[scheduler] Failed to send reminder for job ${job.id}:`, e);
          }
        }
      }
    } catch (err) {
      console.error("[scheduler] Reminder cron error:", err);
    } finally {
      reminderCronRunning = false;
    }
  });

  // ── Auto-nudge CAS (every 5 min) ──
  const AUTO_NUDGE_MESSAGES = [
    `Hey! 👋 Just checking in — haven't heard from you yet. Ready to write your log?`,
    `Still there? 😊 Your logbook is waiting. Even a few sentences is better than nothing!`,
    `Last nudge for today! 😅 Just write something quick — your future self will thank you 🙏`,
  ];

  cron.schedule("*/5 * * * *", async () => {
    if (autoSnoozeCronRunning) return;
    autoSnoozeCronRunning = true;

    try {
      const now = new Date();

      const sentJobs = await prisma.reminderJob.findMany({
        where: {
          status: "sent",
          autoNudgeCount: { lt: 3 },
          user: { botBlocked: false }
        },
        include: { user: true }
      });

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

      if (extraSentIds.length > 0) {
        await prisma.reminderJob.updateMany({
          where: { id: { in: extraSentIds } },
          data: { status: "snoozed", autoNudgeCount: 3 },
        });
      }

      const userIds = Array.from(bestSentByUser.keys());
      const latestLogs = await prisma.log.findMany({
        where: { userId: { in: userIds } },
        orderBy: { logDate: "desc" },
        distinct: ['userId'],
      });
      const latestLogMap = new Map(latestLogs.map((l) => [l.userId, l]));

      for (const [, job] of bestSentByUser) {
        try {
          const nextNudgeAt = new Date(job.scheduledFor.getTime() + (job.autoNudgeCount + 1) * 20 * 60 * 1000);
          if (now < nextNudgeAt) continue; 

          const userForTz = job.user; 
          if (!userForTz) continue;
          
          const userTz = userForTz.timezone ?? "Africa/Lagos";
          const todayStart = localTimeToUtc("00:00", userTz, 0);
          const tomorrowStart = localTimeToUtc("00:00", userTz, 1);

          const lastLog = latestLogMap.get(job.userId);
          const alreadyLoggedToday = lastLog && lastLog.logDate >= todayStart && lastLog.logDate < tomorrowStart;

          if (alreadyLoggedToday) {
            await prisma.reminderJob.update({ where: { id: job.id }, data: { autoNudgeCount: 3 } });
            continue;
          }

          // ATOMIC CAS CLAIM: Optimistically claim this nudge to prevent overlapping cron runs
          const claim = await prisma.reminderJob.updateMany({
            where: { id: job.id, status: "sent", autoNudgeCount: job.autoNudgeCount },
            data: { autoNudgeCount: job.autoNudgeCount + 1 }
          });
          if (claim.count === 0) continue; // Another process claimed it

          const nudgeIndex = job.autoNudgeCount; 
          const nudgeMessage = AUTO_NUDGE_MESSAGES[nudgeIndex];
          const logDate = job.logDate ?? new Intl.DateTimeFormat("en-CA").format(job.scheduledFor);

          try {
            if (nudgeIndex === 2) {
              await sendSceneViaApi(
                bot.api,
                Number(job.telegramId),
                "scene6",
                nudgeMessage,
                { inline_keyboard: [
                    [{ text: "✍️ Write my log", callback_data: `write_log_${job.id}_${logDate}` }],
                    [{ text: "🙈 Skip today", callback_data: `skip_${job.id}` }],
                  ]
                },
              );
              // Final nudge sent, mark as skipped
              await prisma.reminderJob.update({ where: { id: job.id }, data: { status: "skipped" } });
            } else {
              await bot.api.sendMessage(
                Number(job.telegramId),
                nudgeMessage,
                { reply_markup: {
                    inline_keyboard: [
                      [{ text: "✍️ Write my log", callback_data: `write_log_${job.id}_${logDate}` }],
                      [{ text: "🙈 Skip today", callback_data: `skip_${job.id}` }],
                    ],
                  }
                }
              );
            }
          } catch (networkErr: unknown) {
             // Rollback the claim on network failure so it can be retried
             await prisma.reminderJob.updateMany({
               where: { id: job.id, autoNudgeCount: job.autoNudgeCount + 1 },
               data: { autoNudgeCount: job.autoNudgeCount }
             });
             throw networkErr;
          }

        } catch (e: unknown) {
          if (isBotBlockedError(e)) {
            await markUserBlockedAndSkipPendingJobs(job.userId);
          } else {
            console.error(`[scheduler] Auto-nudge failed for job ${job.id}:`, e);
          }
        }
      }
    } catch (err) {
      console.error("[scheduler] Auto-nudge cron error:", err);
    } finally {
      autoSnoozeCronRunning = false;
    }
  });

  // ── Onboarding nudge ──
  cron.schedule("0 19 * * *", async () => {
    if (onboardingNudgeCronRunning) return;
    onboardingNudgeCronRunning = true;

    try {
      const incompleteUsers = await prisma.user.findMany({
        where: { onboardingDone: false, botBlocked: false },
        select: { telegramId: true, firstName: true, id: true },
      });

      for (const user of incompleteUsers) {
        try {
          await bot.api.sendMessage(
            Number(user.telegramId),
            `hey ${user.firstName} 👋\nyou started setting up your Wisa but never finished 😅\n\nwhich means right now you have not started taking your logs and your IT days are already going by 👀\n\nit'll take you about 20 seconds to finish. literally just pick how often you want to log and what time you want to be reminded. that's it.\n\nafter that the bot handles everything 🙏`,
            { reply_markup: { inline_keyboard: [[{ text: "Finish my setup ✅", callback_data: "start_onboarding" }]] } }
          );
        } catch (e: unknown) {
          if (isBotBlockedError(e)) {
            await markUserBlockedAndSkipPendingJobs(user.id);
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

  // ── Storage renewal ──
  cron.schedule("0 19 * * *", async () => {
    if (renewalCronRunning) return;
    renewalCronRunning = true;

    try {
      const lagosToday = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos" }).format(new Date());
      const yesterday = new Date();
      yesterday.setUTCDate(yesterday.getUTCDate() - 1);
      const lagosYesterday = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos" }).format(yesterday);

      const renewalCandidates = await prisma.user.findMany({
        where: { onboardingDone: true, botBlocked: false, nextRenewalDate: { not: null } },
        select: { id: true, telegramId: true, firstName: true, storageUnlocked: true, nextRenewalDate: true, logCount: true },
      });

      for (const user of renewalCandidates) {
        const renewalDate = user.nextRenewalDate;
        if (!renewalDate) continue;
        const renewalLocalDate = new Intl.DateTimeFormat("en-CA", { timeZone: "Africa/Lagos" }).format(renewalDate);

        if (user.storageUnlocked && renewalLocalDate === lagosToday) {
          try {
            await bot.api.sendMessage(
              Number(user.telegramId),
              `Hey ${user.firstName} 👋\n\nYour Wisa storage renews today - just ₦1,000 to keep everything going for another month 🗓️\n\nYour ${user.logCount || ""} logs are still safe. Just tap below to keep the streak alive 🙏`,
              { reply_markup: { inline_keyboard: [[{ text: "🔓 Renew - ₦1,000", callback_data: "go_pro" }]] } }
            );
          } catch (e: unknown) {
            if (isBotBlockedError(e)) {
              await markUserBlockedAndSkipPendingJobs(user.id);
            } else {
              console.error(`[scheduler] Failed renewal notice for user ${user.id}:`, e);
            }
          }
          continue;
        }

        if (user.storageUnlocked && renewalLocalDate === lagosYesterday) {
          await prisma.user.update({ where: { id: user.id }, data: { storageUnlocked: false, isPro: false } });
          try {
            await bot.api.sendMessage(
              Number(user.telegramId),
              `📦 Hey ${user.firstName}, just a reminder - your Wisa storage expired yesterday.\n\nYour logs are all still there and readable. But new ones can't be saved until you renew 🙏\n\n₦1,000 gets you another full month.`,
              { reply_markup: { inline_keyboard: [[{ text: "🔓 Renew now", callback_data: "go_pro" }]] } }
            );
          } catch (e: unknown) {
            if (isBotBlockedError(e)) {
              await markUserBlockedAndSkipPendingJobs(user.id);
            } else {
              console.error(`[scheduler] Failed expiry notice for user ${user.id}:`, e);
            }
          }
        }
      }
    } catch (err) {
      console.error("[scheduler] Renewal cron error:", err);
    } finally {
      renewalCronRunning = false;
    }
  });

  // ── Replay event cleanup ──
  cron.schedule("0 3 * * *", async () => {
    try {
      const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
      const result = await prisma.replayEvent.deleteMany({ where: { timestamp: { lt: cutoff } } });
      if (result.count > 0) {
        console.log(`[scheduler] Cleaned up ${result.count} replay events older than 30 days`);
      }
    } catch (err) {
      console.error("[scheduler] Failed to clean up replay events:", err);
    }
  });

  // ── Auto-save DB Optimizer ──
  const IDLE_PROMPT_MS = 15 * 60 * 1000;
  const IDLE_AUTOSAVE_MS = 30 * 60 * 1000;
  const FIRST_LOG_FOLLOWUP_MS = 30 * 60 * 1000;

  cron.schedule("*/5 * * * *", async () => {
    if (autoSaveCronRunning) return;
    autoSaveCronRunning = true;

    try {
      const allSessions = await prisma.session.findMany();
      const now = Date.now();
      const candidateSessions = [];
      const telegramIdsToFetch = new Set<bigint>();

      // Filter in-memory before hitting the DB
      for (const row of allSessions) {
        try {
          const session: SessionData = JSON.parse(row.value);

          const isAutoSaveCandidate = !!(session.awaitingLog && session.pendingLogParts?.length && session.lastLogMessageAt);
          const isFirstLogCandidate = !!(
            session.awaitingFirstLog &&
            !session.firstLogFollowUpSent &&
            session.firstLogPromptSentAt &&
            now - session.firstLogPromptSentAt >= FIRST_LOG_FOLLOWUP_MS
          );

          if (!isAutoSaveCandidate && !isFirstLogCandidate) continue;

          const chatId = parseInt(row.key, 10);
          if (isNaN(chatId)) continue;

          candidateSessions.push({ row, session, chatId });
          telegramIdsToFetch.add(BigInt(chatId));
        } catch { continue; }
      }

      if (candidateSessions.length === 0) return;

      // Bulk fetch users to avoid N+1 inside the auto-save loop
      const users = await prisma.user.findMany({
        where: { telegramId: { in: Array.from(telegramIdsToFetch) } }
      });
      const userMap = new Map(users.map((u) => [u.telegramId.toString(), u]));

      for (const { row, session, chatId } of candidateSessions) {
        const dbUser = userMap.get(chatId.toString());

        if (
          session.awaitingFirstLog === true &&
          !session.firstLogFollowUpSent &&
          session.firstLogPromptSentAt &&
          now - session.firstLogPromptSentAt >= FIRST_LOG_FOLLOWUP_MS &&
          (!session.pendingLogParts || session.pendingLogParts.length === 0)
        ) {
          session.firstLogFollowUpSent = true;
          session.awaitingFirstLog = false;
          session.awaitingLog = false;
          await prisma.session.update({ where: { id: row.id }, data: { value: JSON.stringify(session) } });
          try {
            await bot.api.sendMessage(
              chatId,
              "Whenever you're ready — just send me what you worked on today and I'll handle the rest 📝",
            );
          } catch (e: unknown) {
            if (isBotBlockedError(e) && dbUser) {
              await markUserBlockedAndSkipPendingJobs(dbUser.id);
            }
          }
          continue;
        }

        const lastActivity = session.lastLogMessageAt;
        if (!lastActivity) continue;
        const idleMs = now - lastActivity;
        if (!dbUser) continue;

        if (session.autoSavePromptSent && idleMs >= IDLE_AUTOSAVE_MS) {
          if (!canCreateLog(dbUser)) {
            try {
              await bot.api.sendMessage(chatId, getStorageWallText(dbUser), {
                parse_mode: "Markdown",
                reply_markup: { inline_keyboard: [[{ text: "🔓 Unlock storage - ₦1,000", callback_data: "go_pro" }]] },
              });
            } catch (e: unknown) {
              if (isBotBlockedError(e)) {
                await markUserBlockedAndSkipPendingJobs(dbUser.id);
              } else {
                console.error(`[auto-save] Failed storage wall notice for chat ${chatId}:`, e);
              }
            }

            session.awaitingLog = false;
            session.pendingLogParts = [];
            session.pendingLogDate = undefined;
            session.flowStartedAt = undefined;
            session.lastLogMessageAt = undefined;
            session.autoSavePromptSent = undefined;

            await prisma.session.update({ where: { id: row.id }, data: { value: JSON.stringify(session) } });
            continue;
          }

          const fullText = session.pendingLogParts.join("\n\n").trim();
          if (!fullText) continue;
          const logDate = session.pendingLogDate ? parseISO(session.pendingLogDate) : new Date();

          const [savedLog, updatedUser] = await prisma.$transaction([
            prisma.log.create({
              data: { userId: dbUser.id, content: fullText, logDate, isVoice: false, isAiRefined: false },
            }),
            prisma.user.update({
              where: { id: dbUser.id },
              data: { logCount: { increment: 1 } },
              select: { id: true, firstName: true, isPro: true, storageUnlocked: true, logCount: true, nextRenewalDate: true },
            }),
          ]);

          session.awaitingLog = false;
          session.pendingLogParts = [];
          session.pendingLogDate = undefined;
          session.flowStartedAt = undefined;
          session.lastLogMessageAt = undefined;
          session.autoSavePromptSent = undefined;

          await prisma.session.update({ where: { id: row.id }, data: { value: JSON.stringify(session) } });

          try {
            await bot.api.sendMessage(
              chatId,
              `✅ I went ahead and saved your log because it looked like you were done.\n\n📖 ${fullText.length > 150 ? fullText.slice(0, 150) + "…" : fullText}\n\nYou can always edit it later from your calendar 📅`,
              { reply_markup: { inline_keyboard: [
                    [{ text: "✨ Refine with AI", callback_data: `ai_refine_${savedLog.id}` }],
                    [{ text: "📖 View logs", callback_data: "nav_calendar" }, { text: "🏠 Menu", callback_data: "nav_menu" }],
                  ] }
              }
            );

            if (!hasActiveStorage(updatedUser) && updatedUser.logCount === FREE_LOG_LIMIT) {
              await bot.api.sendMessage(chatId, getStorageLimitReachedAfterSaveText(), {
                parse_mode: "Markdown",
                reply_markup: { inline_keyboard: [[{ text: "🔓 Unlock storage - ₦1,000", callback_data: "go_pro" }]] },
              });
            }
          } catch (sendErr: unknown) {
            if (isBotBlockedError(sendErr)) {
              await markUserBlockedAndSkipPendingJobs(dbUser.id);
            } else {
              console.error(`[auto-save] Failed to notify chat ${chatId}:`, sendErr);
            }
          }
          continue;
        }

        if (!session.autoSavePromptSent && idleMs >= IDLE_PROMPT_MS) {
          session.autoSavePromptSent = true;
          await prisma.session.update({ where: { id: row.id }, data: { value: JSON.stringify(session) } });
          const wordCount = session.pendingLogParts.join(" ").split(/\s+/).filter(Boolean).length;

          try {
            await bot.api.sendMessage(
              chatId,
              `Hey! 👋 Looks like you stopped writing.\n\nI've got *${wordCount} word${wordCount === 1 ? "" : "s"}* so far. Want me to save it, or are you still going?`,
              { parse_mode: "Markdown",
                reply_markup: { inline_keyboard: [[{ text: "💾 Save it", callback_data: "auto_save_confirm" }], [{ text: "✏️ I'm still writing", callback_data: "auto_save_continue" }]] }
              }
            );
          } catch (sendErr: unknown) {
            if (isBotBlockedError(sendErr)) {
              await markUserBlockedAndSkipPendingJobs(dbUser.id);
            } else {
              console.error(`[auto-save] Failed to prompt chat ${chatId}:`, sendErr);
            }
          }
        }
      }
    } catch (err) {
      console.error("[scheduler] Auto-save cron error:", err);
    } finally {
      autoSaveCronRunning = false;
    }
  });

  let weeklyRecapCronRunning = false;
  cron.schedule("0 11 * * 6", async () => {
    if (weeklyRecapCronRunning) return;
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