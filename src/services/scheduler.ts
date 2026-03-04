import cron from "node-cron";
import { Bot } from "grammy";
import { prisma } from "../lib/prisma";
import { getReminderMessage, scheduleNextJob } from "../bot/reminders";
import { sendSceneViaApi } from "../utils/constants";
import { captureReplayError } from "./replayCapture";
import type { BotContext } from "../bot/types";

export function startScheduler(bot: Bot<BotContext>): void {
  // ── Re-entry locks — prevent overlapping async cron ticks ───────────────
  let reminderCronRunning = false;
  let autoSnoozeCronRunning = false;
  let onboardingNudgeCronRunning = false;

  // ── 5.1 — Fire due reminders (every minute) ───────────────────────────────
  cron.schedule("* * * * *", async () => {
    if (reminderCronRunning) {
      console.log("[scheduler] Reminder cron still running from previous tick — skipping");
      return;
    }
    reminderCronRunning = true;

    try {
    const dueJobs = await prisma.reminderJob.findMany({
      where: { status: "pending", scheduledFor: { lte: new Date() } },
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
        data: { status: "sent" },
      });
      console.log(`[scheduler] Retired ${duplicateJobIds.length} duplicate due jobs`);
    }

    for (const [, job] of bestJobByUser) {
      try {
        // ── Skip if user already wrote a log today ───────────────────────
        const todayStart = new Date();
        todayStart.setUTCHours(0, 0, 0, 0);
        const tomorrowStart = new Date(todayStart);
        tomorrowStart.setUTCDate(tomorrowStart.getUTCDate() + 1);

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

        await sendSceneViaApi(
          bot.api,
          Number(job.telegramId),
          "scene5",
          getReminderMessage(),
          {
            inline_keyboard: [
              [{ text: "✍️ Write my log", callback_data: "write_log" }],
              [{ text: "⏳ Remind me in 30 mins", callback_data: `snooze_${job.id}` }],
              [{ text: "🙈 Skip today", callback_data: `skip_${job.id}` }],
            ],
          },
        );

        await prisma.reminderJob.update({
          where: { id: job.id },
          data: { status: "sent" },
        });

        // Queue the next scheduled job (guard inside prevents duplicates)
        await scheduleNextJob(job.userId, job.telegramId);
      } catch (e) {
        console.error(`[scheduler] Failed to send reminder for job ${job.id}:`, e);
        captureReplayError(job.telegramId, e, "scheduler:sendReminder");
      }
    }

    } finally {
      reminderCronRunning = false;
    }
  });

  // ── 5.4 — Auto-snooze: re-queue unanswered reminders (every 5 minutes) ───
  cron.schedule("*/5 * * * *", async () => {
    if (autoSnoozeCronRunning) {
      console.log("[scheduler] Auto-snooze cron still running from previous tick — skipping");
      return;
    }
    autoSnoozeCronRunning = true;

    try {
    const thirtyMinsAgo = new Date(Date.now() - 30 * 60 * 1000);

    // Jobs that were sent more than 30 mins ago and never acted on
    const staleJobs = await prisma.reminderJob.findMany({
      where: {
        status: "sent",
        scheduledFor: { lte: thirtyMinsAgo },
        snoozeCount: { lt: 3 },
      },
    });

    // ── Deduplicate: only process ONE stale job per user (the latest) ───
    const bestStaleByUser = new Map<number, (typeof staleJobs)[0]>();
    const extraStaleIds: number[] = [];

    for (const job of staleJobs) {
      const existing = bestStaleByUser.get(job.userId);
      if (!existing || job.scheduledFor > existing.scheduledFor) {
        if (existing) extraStaleIds.push(existing.id);
        bestStaleByUser.set(job.userId, job);
      } else {
        extraStaleIds.push(job.id);
      }
    }

    // Retire duplicates
    if (extraStaleIds.length > 0) {
      await prisma.reminderJob.updateMany({
        where: { id: { in: extraStaleIds } },
        data: { status: "snoozed" },
      });
      console.log(`[scheduler] Retired ${extraStaleIds.length} duplicate stale jobs`);
    }

    for (const [, job] of bestStaleByUser) {
      try {
        // ── Skip if user already wrote a log today ───────────────────────
        const todayStart = new Date();
        todayStart.setUTCHours(0, 0, 0, 0);
        const tomorrowStart = new Date(todayStart);
        tomorrowStart.setUTCDate(tomorrowStart.getUTCDate() + 1);

        const todayLog = await prisma.log.findFirst({
          where: { userId: job.userId, logDate: { gte: todayStart, lt: tomorrowStart } },
        });

        if (todayLog) {
          await prisma.reminderJob.update({ where: { id: job.id }, data: { status: "snoozed" } });
          console.log(`[scheduler] Skipped auto-snooze for user ${job.userId} — already logged today`);
          continue;
        }

        const newSnoozeCount = job.snoozeCount + 1;

        await prisma.reminderJob.update({
          where: { id: job.id },
          data: { snoozeCount: newSnoozeCount, status: "snoozed" },
        });

        if (newSnoozeCount >= 3) {
          // Final auto-nudge — Scene 6
          await sendSceneViaApi(
            bot.api,
            Number(job.telegramId),
            "scene6",
            `Okay okay, last reminder for today! 😅\n\nYou've been quiet a while — just write *something*, even one sentence. Your logbook needs you! 🙏`,
            {
              inline_keyboard: [
                [{ text: "✍️ Write my log", callback_data: "write_log" }],
              ],
            },
          );
        } else {
          // Auto-re-queue 30 mins from now — only if no pending job exists
          const existingPending = await prisma.reminderJob.findFirst({
            where: { userId: job.userId, status: "pending" },
          });

          if (!existingPending) {
            const snoozedUntil = new Date(Date.now() + 30 * 60 * 1000);
            await prisma.reminderJob.create({
              data: {
                userId: job.userId,
                telegramId: job.telegramId,
                scheduledFor: snoozedUntil,
                status: "pending",
                snoozeCount: newSnoozeCount,
              },
            });
          }
        }
      } catch (e) {
        console.error(`[scheduler] Auto-snooze failed for job ${job.id}:`, e);
      }
    }

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
        where: { onboardingDone: false },
        select: { telegramId: true, firstName: true },
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
        } catch (e) {
          console.error(`[scheduler] Failed to send onboarding nudge to ${user.telegramId}:`, e);
        }
      }
    } finally {
      onboardingNudgeCronRunning = false;
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

  console.log("[scheduler] Reminder cron jobs started.");
}
