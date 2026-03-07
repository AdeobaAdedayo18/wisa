import { InlineKeyboard } from "grammy";
import { prisma } from "../lib/prisma";
import { localTimeToUtc, skipWeekend } from "../utils/dateHelpers";
import { sendScene } from "../utils/constants";
import { startLogging } from "./logging";
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

  // Don't schedule new reminders for users who blocked the bot
  if (user.botBlocked) {
    console.log(`[scheduler] Skipped scheduleNextJob for user ${userId} — bot is blocked`);
    return;
  }

  // ── Guard: skip if this user already has a future SCHEDULED pending job ──
  // Only block if there's a pending job > 4 hours away (next-day type).
  // This allows snooze jobs (30 min away) to coexist.
  const fourHoursFromNow = new Date(Date.now() + 4 * 60 * 60 * 1000);
  const existingScheduled = await prisma.reminderJob.findFirst({
    where: { userId, status: "pending", scheduledFor: { gte: fourHoursFromNow } },
  });
  if (existingScheduled) {
    console.log(
      `[scheduler] Skipped scheduleNextJob for user ${userId} — already has scheduled job #${existingScheduled.id} at ${existingScheduled.scheduledFor.toISOString()}`,
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

  // Skip weekends — push Saturday/Sunday reminders to Monday
  const adjustedScheduledFor = skipWeekend(scheduledFor, user.timezone);

  // Compute the log date in the user's local timezone
  const logDate = new Intl.DateTimeFormat("en-CA", { timeZone: user.timezone }).format(adjustedScheduledFor);

  await prisma.reminderJob.create({
    data: { userId, telegramId, scheduledFor: adjustedScheduledFor, status: "pending", logDate },
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
      data: { snoozeCount: newSnoozeCount, status: "snoozed", autoNudgeCount: 3 },
    });

    // Build "Write my log" button with the correct date
    const logDate = job.logDate ?? new Intl.DateTimeFormat("en-CA").format(new Date());

    await sendScene(
      ctx,
      "scene6",
      `Okay okay, last reminder for today! 😅\n\nYou've snoozed 3 times — just write *something*, even one sentence. Your logbook needs you! 🙏`,
    );

    // Send a follow-up with actionable buttons (sendScene doesn't support reply_markup)
    await ctx.reply("Tap below to start writing 👇", {
      reply_markup: new InlineKeyboard()
        .text("✍️ Write my log", `write_log_${jobId}_${logDate}`)
        .row()
        .text("🙈 Skip today", `skip_${jobId}`),
    });
  } else {
    // Create a new job 30 minutes from NOW — only check for nearby pending jobs
    const snoozedUntil = new Date(Date.now() + 30 * 60 * 1000);

    // Mark original job as snoozed (stops auto-nudge too)
    await prisma.reminderJob.update({
      where: { id: jobId },
      data: { snoozeCount: newSnoozeCount, status: "snoozed", autoNudgeCount: 3 },
    });

    // Only check for pending jobs within the next 2 hours to avoid blocking
    // on next-day scheduled jobs. This prevents duplicate snooze jobs
    // while allowing snooze + next-day to coexist.
    const twoHoursFromNow = new Date(Date.now() + 2 * 60 * 60 * 1000);
    const existingNearPending = await prisma.reminderJob.findFirst({
      where: {
        userId: job.userId,
        status: "pending",
        scheduledFor: { lte: twoHoursFromNow },
      },
    });

    if (!existingNearPending) {
      await prisma.reminderJob.create({
        data: {
          userId: job.userId,
          telegramId: job.telegramId,
          scheduledFor: snoozedUntil,
          status: "pending",
          snoozeCount: newSnoozeCount,
          autoNudgeCount: 0, // reset auto-nudge for the new job
          logDate: job.logDate, // carry forward the original log date
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

// ---------------------------------------------------------------------------
// "Write my log" from a reminder button — callback: `write_log_<jobId>_<date>`
// ---------------------------------------------------------------------------

export async function handleWriteFromReminder(ctx: BotContext): Promise<void> {
  const data = ctx.callbackQuery?.data ?? "";
  // Format: write_log_<jobId>_<YYYY-MM-DD>
  const match = data.match(/^write_log_(\d+)_(\d{4}-\d{2}-\d{2})$/);
  await ctx.answerCallbackQuery();

  if (!match) {
    // Fallback: treat as generic write_log (today)
    await startLogging(ctx);
    return;
  }

  const jobId = parseInt(match[1], 10);
  const logDate = match[2];

  // Mark the job as interacted-with so auto-nudge stops
  try {
    await prisma.reminderJob.update({
      where: { id: jobId },
      data: { autoNudgeCount: 3 }, // stops auto-nudge; status stays "sent"
    });
  } catch {
    // Job might not exist or already be in a different state — that's fine
  }

  // Remove buttons from the reminder message
  await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {});

  // Start logging for the date the reminder was originally for
  await startLogging(ctx, logDate);
}
