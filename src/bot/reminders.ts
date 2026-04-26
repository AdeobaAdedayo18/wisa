import { InlineKeyboard } from "grammy";
import { prisma } from "../lib/prisma";
import { localTimeToUtc, skipWeekend } from "../utils/dateHelpers";
import { sendScene } from "../utils/constants";
import { startLogging } from "./logging";
import type { BotContext } from "./types";
// ---------------------------------------------------------------------------
// Dynamic Reminder Message Copy (Time & Ghost Aware)
// ---------------------------------------------------------------------------
export const MORNING_GREETINGS = [
  `🌅 *Good morning!* Wishing you a highly productive day at work. You've got this!`,
  `☀️ *Rise and grind!* Step into today with energy. Have an amazing day!`,
  `🚀 *Good morning!* Another day to learn, build, and grow. Make it count today!`,
  `☕️ *Morning!* Get out there and smash your goals today. (And take mental notes for your log later!)`,
  `🌟 *Good morning!* Go out and be great today. We are rooting for you 🙌`,
  `💼 *New day, new wins!* Have a fantastic day at work. Don't forget to observe what you do today!`,
  `🌤 *Good morning!* Walk in there like you own the place. You belong in that office 💪`,
  `🎒 *Today is another chapter.* Pay attention — the things you learn today are worth writing down tonight.`,
  `🔋 *Fully charged and ready?* Good. Go show them what you're made of. Big day ahead!`,
  `🌞 *Morning!* Even if today feels slow, show up fully. The best logs come from the days you least expected.`,
  `💡 *Good morning!* Ask one question at work today you've been holding back. Then log what you learned 📝`,
  `🏃 *Up and at it!* The intern that shows up with energy stands out. Go be that person today.`,
];

export const MOTIVATIONAL_SHORTS = [
  `⚡️ *Little drops of water...* One log a day completes your SIWES journey. Let's go!`,
  `💪 *Consistency is your superpower.* Keep the momentum going and write today's entry!`,
  `🎯 *You did the work, now claim the credit.* Update your logbook and close out the day strong.`,
  `📝 *Empty logbooks don't win awards.* Even a single sentence is progress! Just write something.`,
  `🚀 *Secure the bag!* A consistent logbook is proof of your hard work. Don't leave today blank.`,
  `🧠 *Memory fades, but databases last forever.* Log your tasks now before you go to sleep!`,
  `✍️ *Small habits, massive results.* Take exactly 2 minutes to document your day right now.`,
  `📖 *Your future self is counting on you.* Write the log today so you're not guessing at your defence tomorrow.`,
  `🏆 *The work already happened.* All you have to do now is write it down. That part is easy.`,
  `🔒 *Lock it in.* Today's experience is worth keeping. Don't let it slip through the cracks.`,
  `🌱 *Growth you don't document is growth you can't prove.* Two minutes. Write it down.`,
  `👀 *Your supervisor wants to see receipts.* A full, consistent logbook is the receipt. Stay consistent.`,
  `📅 *Don't break the chain.* You've come this far — one more entry keeps the streak alive.`,
  `⏳ *Before you sleep tonight,* take 2 minutes to tell Wisa what happened today. That's it. That's the whole task.`,
];

export const NIGHT_FOMO_NUDGES = [
  `🌍 *Over 100+ people have already updated their logbooks today.* Don't be the only one left behind—join them!`,
  `🔥 *You're in good company!* 120+ interns just saved their daily logs. Secure your own record right now.`,
  `⚠️ *Procrastination is a trap!* Write your log now while it's fresh. Future you will be so grateful when submission time comes.`,
  `📈 *The community is moving!* 100+ interns just saved their daily logs. Tap below to write yours now.`,
  `🏆 *Top performers don't skip days.* Over 100 people have logged today. Are you one of them?`,
  `🌙 *The day is almost over.* Most of your fellow IT students have already logged. Don't go to sleep empty-handed.`,
  `💬 *Right now, hundreds of students are writing their logs.* It takes less time than scrolling Twitter. Join them.`,
  `😴 *Don't sleep on this.* Literally — log before you sleep. Tomorrow you won't remember the details like you do right now.`,
  `📲 *Quick check:* did you log today? 100+ students already did. 30 seconds and you're caught up.`,
  `🕯 *End the day right.* A quick log before bed is all it takes to stay ahead. You're almost there.`,
];

export const GHOST_CHECK_INS = [
  `👀 *Long time no see!* Your SIWES logbook is gathering dust. Work getting busy? Drop a quick 1-sentence update so you don't lose your record!`,
  `👻 *Did you ghost us?* Over 150+ students are keeping their streaks alive. It takes exactly 60 seconds to catch up. Tap below!`,
  `🚨 *Streak at risk!* You haven't logged in a few days. The longer you wait, the harder it is to remember. Just write one thing you did this week!`,
  `🫣 *We noticed you've been quiet.* No judgement — IT gets hectic. But your logbook still needs you. One sentence is enough to get back on track.`,
  `📭 *Your log history has a gap in it.* It's not too late to fill it in. Go back to any missed day and write what you remember before it fades.`,
  `🔔 *Hey, we miss you!* A lot has probably happened at work since you last logged. Don't let it all disappear — even a quick summary counts.`,
  `🧩 *Something is missing from your logbook.* That something is you. Come back, even if it's just for today.`,
  `⏰ *Time check:* every day you don't log is a day you'll have to make up at your defence. The easiest time to write it is always right now.`,
];
/**
 * Returns a dynamic message and a boolean indicating if it should be sent silently.
 * @param reminderTime Format "HH:mm" (e.g., "08:00")
 * @param daysSinceLastLog Number of days since the user's last log
 */
export function getReminderMessage(
  localHour: number,
  daysSinceLastLog: number
): { text: string; isSilent: boolean; bucket: string } {
  if (daysSinceLastLog > 3) {
    // Ghost protocol: Active notification
    return {
      text: GHOST_CHECK_INS[Math.floor(Math.random() * GHOST_CHECK_INS.length)],
      isSilent: false,
      bucket: "GHOST",
    };
  }

  if (localHour >= 5 && localHour < 12) {
    // Morning: Active notification
    return {
      text: MORNING_GREETINGS[Math.floor(Math.random() * MORNING_GREETINGS.length)],
      isSilent: false,
      bucket: "MORNING",
    };
  } else if (localHour >= 12 && localHour < 17) {
    // Afternoon: Silent sneak attack
    return {
      text: MOTIVATIONAL_SHORTS[Math.floor(Math.random() * MOTIVATIONAL_SHORTS.length)],
      isSilent: true,
      bucket: "AFTERNOON_SILENT",
    };
  } else {
    // Night: Active FOMO
    return {
      text: NIGHT_FOMO_NUDGES[Math.floor(Math.random() * NIGHT_FOMO_NUDGES.length)],
      isSilent: false,
      bucket: "NIGHT",
    };
  }
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

  const user = await prisma.user.findUnique({
    where: { id: job.userId },
    select: { timezone: true },
  });
  const userTz = user?.timezone ?? "Africa/Lagos";

  // Check if the user already logged today before sending any nudge
  const todayStart = localTimeToUtc("00:00", userTz, 0);
  const tomorrowStart = localTimeToUtc("00:00", userTz, 1);

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

    try {
      // Mark original job as snoozed (stops auto-nudge too)
      await prisma.reminderJob.update({
        where: { id: jobId },
        data: { snoozeCount: newSnoozeCount, status: "snoozed", autoNudgeCount: 3 },
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
    } catch (e) {
      // Rollback so the user isn't stranded without a reminder
      await prisma.reminderJob.update({
        where: { id: jobId },
        data: { status: "pending" },
      });
      throw e;
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
    const job = await prisma.reminderJob.findUnique({ where: { id: jobId } });
    await prisma.reminderJob.update({
      where: { id: jobId },
      data: {
        autoNudgeCount: 3,
        convertedAt: job?.convertedAt ? undefined : new Date(),
      }, // stops auto-nudge; status stays "sent"
    });
  } catch {
    // Job might not exist or already be in a different state — that's fine
  }

  // Remove buttons from the reminder message
  await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {});

  // Start logging for the date the reminder was originally for
  await startLogging(ctx, logDate);
}
