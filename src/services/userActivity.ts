import cron from "node-cron";
import { Bot } from "grammy";
import { prisma } from "../lib/prisma";
import type { BotContext } from "../bot/types";

/**
 * Phase 10 — Keep-Active Strategy
 * Registers two scheduled tasks:
 *   1. Monthly check-in ping (1st of every month, 9 am)
 *   2. Daily inactivity nudge (every day 9 am — users silent for 7+ days)
 */
export function startUserActivity(bot: Bot<BotContext>): void {
  // ── 10.1 — Monthly check-in (9 am on the 1st of each month) ──────────────
  cron.schedule("0 9 1 * *", async () => {
    try {
      const users = await prisma.user.findMany({ where: { onboardingDone: true } });
      for (const user of users) {
        try {
          await bot.api.sendMessage(
            Number(user.telegramId),
            `Hey ${user.firstName}! 👋 New month, new logs 📅 Just tap below so I know you're still here 😊`,
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: "I'm here! 👋", callback_data: "keepalive" }],
                ],
              },
            },
          );
        } catch (e) {
          console.error(`[userActivity] Monthly ping failed for user ${user.id}:`, e);
        }
      }
    } catch (e) {
      console.error("[userActivity] Monthly check-in cron error:", e);
    }
  });

  // ── 10.2 — Daily inactivity nudge (9 am every day) ───────────────────────
  // Users with no log created or updated in the last 7 days receive a gentle nudge.
  cron.schedule("0 9 * * *", async () => {
    try {
      const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

      // Find onboarded users whose most-recent log is older than 7 days (or who have none)
      const inactiveUsers = await prisma.user.findMany({
        where: {
          onboardingDone: true,
          logs: {
            none: {
              createdAt: { gte: sevenDaysAgo },
            },
          },
        },
      });

      for (const user of inactiveUsers) {
        try {
          await bot.api.sendMessage(
            Number(user.telegramId),
            `Hey ${user.firstName}! 👋 It's been a while since your last log 🤔\n\n` +
              `Your SIWES logbook misses you! Even a quick entry keeps your record in great shape 📖\n\n` +
              `Tap below to get back on track 💪`,
            {
              reply_markup: {
                inline_keyboard: [
                  [{ text: "✍️ Write my log", callback_data: "write_log" }],
                  [{ text: "📅 View calendar", callback_data: "nav_calendar" }],
                ],
              },
            },
          );
        } catch (e) {
          console.error(`[userActivity] Inactivity nudge failed for user ${user.id}:`, e);
        }
      }
    } catch (e) {
      console.error("[userActivity] Daily nudge cron error:", e);
    }
  });
}
