import { prisma } from "../lib/prisma";
import { localTimeToUtc } from "../utils/dateHelpers";
import { sendScene } from "../utils/constants";
import type { BotContext } from "./types";

// ---------------------------------------------------------------------------
// Reminder message copy (Scene 5 caption)
// ---------------------------------------------------------------------------

const REMINDER_MESSAGES = [
  `📝 *Time to log your day!*\n\nWhat did you work on today? Even a few sentences counts. Your future self will thank you 🙌`,
  `✍️ *Log time!*\n\nYour SIWES diary is waiting. What happened at work today?`,
  `📖 *Hey, logbook check-in!*\n\nDon't let today's wins go unrecorded. Write your log now 🚀`,
  `🗒️ *Daily log reminder*\n\nTake 2 minutes to capture today's work activities. You've got this 💪`,
];

export function getReminderMessage(): string {
  return REMINDER_MESSAGES[Math.floor(Math.random() * REMINDER_MESSAGES.length)];
}

// ---------------------------------------------------------------------------
// Schedule the NEXT ReminderJob for a user after a job fires
// ---------------------------------------------------------------------------

export async function scheduleNextJob(userId: number, telegramId: bigint): Promise<void> {
  const user = await prisma.user.findUnique({ where: { id: userId } });
  if (!user) return;

  // ── Guard: skip if this user already has a future pending job ──────────
  const existingPending = await prisma.reminderJob.findFirst({
    where: { userId, status: "pending", scheduledFor: { gt: new Date() } },
  });
  if (existingPending) {
    console.log(
      `[scheduler] Skipped scheduleNextJob for user ${userId} — already has pending job #${existingPending.id} at ${existingPending.scheduledFor.toISOString()}`,
    );
    return;
  }

  const intervalDays =
    (
      {
        daily: 1,
        "bi-daily": 2,
        "every-3-days": 3,
        weekly: 7,
      } as Record<string, number>
    )[user.logFrequency] ?? 1;

  const scheduledFor = localTimeToUtc(user.reminderTime, user.timezone, intervalDays);

  await prisma.reminderJob.create({
    data: { userId, telegramId, scheduledFor, status: "pending" },
  });
}

// ---------------------------------------------------------------------------
// Snooze handler — callback: `snooze_<jobId>`
// ---------------------------------------------------------------------------

export async function handleSnooze(ctx: BotContext): Promise<void> {
  const data = ctx.callbackQuery?.data ?? "";
  const jobId = parseInt(data.replace("snooze_", ""), 10);
  await ctx.answerCallbackQuery();

  const job = await prisma.reminderJob.findUnique({ where: { id: jobId } });
  if (!job) {
    await ctx.reply("Couldn't find that reminder. It may have already been handled.");
    return;
  }

  // Check if the user already logged today before sending any nudge
  const todayStart = new Date();
  todayStart.setUTCHours(0, 0, 0, 0);
  const tomorrowStart = new Date(todayStart);
  tomorrowStart.setUTCDate(tomorrowStart.getUTCDate() + 1);

  const todayLog = await prisma.log.findFirst({
    where: { userId: job.userId, logDate: { gte: todayStart, lt: tomorrowStart } },
  });

  if (todayLog) {
    await prisma.reminderJob.update({ where: { id: jobId }, data: { status: "sent" } });
    await ctx.reply("You've already logged today — great work! 🎉");
    return;
  }

  const newSnoozeCount = job.snoozeCount + 1;

  if (newSnoozeCount >= 3) {
    // Final nudge — no more snooze option
    await prisma.reminderJob.update({
      where: { id: jobId },
      data: { snoozeCount: newSnoozeCount, status: "snoozed" },
    });

    await sendScene(
      ctx,
      "scene6",
      `Okay okay, last reminder for today! 😅\n\nYou've snoozed 3 times — just write *something*, even one sentence. Your logbook needs you! 🙏`,
    );
  } else {
    // Create a new job 30 minutes from now — but only if user has no pending job already
    const snoozedUntil = new Date(Date.now() + 30 * 60 * 1000);

    await prisma.reminderJob.update({
      where: { id: jobId },
      data: { snoozeCount: newSnoozeCount, status: "snoozed" },
    });

    const existingPending = await prisma.reminderJob.findFirst({
      where: { userId: job.userId, status: "pending" },
    });

    if (!existingPending) {
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

    await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
    await ctx.reply(
      `⏳ Got it! I'll remind you again in 30 minutes. Go do your thing 😊`,
    );
  }
}

// ---------------------------------------------------------------------------
// Skip handler — callback: `skip_<jobId>`
// ---------------------------------------------------------------------------

export async function handleSkip(ctx: BotContext): Promise<void> {
  const data = ctx.callbackQuery?.data ?? "";
  const jobId = parseInt(data.replace("skip_", ""), 10);
  await ctx.answerCallbackQuery();

  await prisma.reminderJob.update({
    where: { id: jobId },
    data: { status: "skipped" },
  });

  await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } });
  await ctx.reply("No wahala! 😊 See you next time 👋");
}
