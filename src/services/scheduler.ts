import cron from "node-cron";
import { Bot } from "grammy";
import { prisma } from "../lib/prisma";
import { getReminderMessage, scheduleNextJob } from "../bot/reminders";
import type { BotContext } from "../bot/types";

export function startScheduler(bot: Bot<BotContext>): void {
  // ── 5.1 — Fire due reminders (every minute) ───────────────────────────────
  cron.schedule("* * * * *", async () => {
    const dueJobs = await prisma.reminderJob.findMany({
      where: { status: "pending", scheduledFor: { lte: new Date() } },
    });

    for (const job of dueJobs) {
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

        await bot.api.sendMessage(Number(job.telegramId), getReminderMessage(), {
          parse_mode: "Markdown",
          reply_markup: {
            inline_keyboard: [
              [{ text: "✍️ Write my log", callback_data: "write_log" }],
              [{ text: "⏳ Remind me in 30 mins", callback_data: `snooze_${job.id}` }],
              [{ text: "🙈 Skip today", callback_data: `skip_${job.id}` }],
            ],
          },
        });

        await prisma.reminderJob.update({
          where: { id: job.id },
          data: { status: "sent" },
        });

        // Immediately queue the next scheduled job for this user
        await scheduleNextJob(job.userId, job.telegramId);
      } catch (e) {
        console.error(`[scheduler] Failed to send reminder for job ${job.id}:`, e);
      }
    }
  });

  // ── 5.4 — Auto-snooze: re-queue unanswered reminders (every 5 minutes) ───
  cron.schedule("*/5 * * * *", async () => {
    const thirtyMinsAgo = new Date(Date.now() - 30 * 60 * 1000);

    // Jobs that were sent more than 30 mins ago and never acted on
    const staleJobs = await prisma.reminderJob.findMany({
      where: {
        status: "sent",
        scheduledFor: { lte: thirtyMinsAgo },
        snoozeCount: { lt: 3 },
      },
    });

    for (const job of staleJobs) {
      try {
        const newSnoozeCount = job.snoozeCount + 1;

        await prisma.reminderJob.update({
          where: { id: job.id },
          data: { snoozeCount: newSnoozeCount, status: "snoozed" },
        });

        if (newSnoozeCount >= 3) {
          // Final auto-nudge — send Scene 6 message directly
          await bot.api.sendMessage(
            Number(job.telegramId),
            `Okay okay, last reminder for today! 😅\n\nYou've been quiet a while — just write *something*, even one sentence. Your logbook needs you! 🙏`,
            {
              parse_mode: "Markdown",
              reply_markup: {
                inline_keyboard: [
                  [{ text: "✍️ Write my log", callback_data: "write_log" }],
                ],
              },
            },
          );
        } else {
          // Auto-re-queue 30 mins from now
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
      } catch (e) {
        console.error(`[scheduler] Auto-snooze failed for job ${job.id}:`, e);
      }
    }
  });

  console.log("[scheduler] Reminder cron jobs started.");
}
