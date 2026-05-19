import { InlineKeyboard, Keyboard } from "grammy";
import { type Conversation } from "@grammyjs/conversations";
import { prisma } from "../lib/prisma";
import { sendScene } from "../utils/constants";
import { localTimeToUtc, hasLocalTimePassed } from "../utils/dateHelpers";
import type { BotContext } from "./types";
import { clearActiveFlow } from "./types";
import { hasActiveStorage } from "./monetization";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

type OnboardingConversation = Conversation<BotContext, BotContext>;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const MAIN_MENU_BASE = new Keyboard()
  .text("✍️ Write today's log").row()
  .text("� Catch up missed days").row()
  .text("📖 See my logs").text("💬 Leave feedback").row()
  .text("✨ AI Refine").text("⚙️ Settings")
  .resized()
  .persistent();

const MAIN_MENU_WITH_PRO = new Keyboard()
  .text("✍️ Write today's log").row()
  .text("🔄 Catch up missed days").row()
  .text("📖 See my logs").text("💬 Leave feedback").row()
  .text("✨ AI Refine").text("👑 Go Pro").row()
  .text("⚙️ Settings")
  .resized()
  .persistent();

export function getMainMenuKeyboard(storageUnlocked: boolean): Keyboard {
  return storageUnlocked ? MAIN_MENU_BASE : MAIN_MENU_WITH_PRO;
}

/**
 * Create a SINGLE next ReminderJob for a user.
 *
 * Key behaviour: if the reminder time has NOT yet passed today (in the user's
 * timezone), the job is scheduled for today. Otherwise it starts from
 * the next interval day. The stored date is in UTC.
 *
 * Only ONE pending job is created — `scheduleNextJob()` in the scheduler
 * creates the following one after each job fires, avoiding duplicate buildup.
 */
export async function createInitialReminderJobs(
  userId: number,
  telegramId: bigint,
  frequency: string,
  reminderTime: string,
  timezone = "Africa/Lagos",
) {
  const intervalDays =
    ({ daily: 1, "bi-daily": 2, "every-3-days": 3, weekly: 7 } as Record<string, number>)[frequency] ?? 1;

  // If the reminder time hasn't passed today in the user's TZ, start from today.
  const startOffset = hasLocalTimePassed(reminderTime, timezone) ? intervalDays : 0;

  const scheduledFor = localTimeToUtc(reminderTime, timezone, startOffset);

  console.log(
    `[reminders] Created 1 job for user ${userId} (tz=${timezone}) — at ${scheduledFor.toISOString()}`,
  );

  await prisma.reminderJob.create({
    data: { userId, telegramId, scheduledFor, status: "pending" },
  });
}

/** Build the 33-button time picker keyboard (06:00–22:00, 30-min steps). */
export function buildTimeKeyboard(callbackPrefix = "time_"): InlineKeyboard {
  const kb = new InlineKeyboard();
  const times: string[] = [];
  for (let h = 6; h <= 22; h++) {
    for (const m of [0, 30]) {
      if (h === 22 && m === 30) break; // stop at 22:00 (inclusive)
      const label = `${String(h).padStart(2, "0")}:${String(m).padStart(2, "0")}`;
      times.push(label);
    }
  }
  // Lay out 4 buttons per row
  times.forEach((t, i) => {
    kb.text(t, `${callbackPrefix}${t}`);
    if ((i + 1) % 4 === 0) kb.row();
  });
  return kb;
}

/** Friendly label for a frequency DB value. */
function frequencyLabel(freq: string): string {
  return (
    { daily: "Every day", "bi-daily": "Every 2 days", "every-3-days": "Every 3 days", weekly: "Once a week" }[
      freq
    ] ?? freq
  );
}

// ---------------------------------------------------------------------------
// The onboarding conversation
// ---------------------------------------------------------------------------

export async function onboardingConversation(conversation: OnboardingConversation, ctx: BotContext) {
  // ── Step 2 — Frequency selection ──────────────────────────────────────────
  await sendScene(ctx, "scene2", "How often do you want to write your log? 📅");

  const freqKeyboard = new InlineKeyboard()
    .text("Every day", "freq_daily").text("Every 2 days", "freq_bi-daily");

  await ctx.reply("Pick your log frequency:", { reply_markup: freqKeyboard });

  const freqCtx = await conversation.waitForCallbackQuery(/^freq_/);
  await freqCtx.answerCallbackQuery();
  const frequency = freqCtx.callbackQuery.data.replace("freq_", "");

  // ── Step 3 — Time picker ──────────────────────────────────────────────────
  await sendScene(ctx, "scene3", "What time should I remind you to write your log? ⏰");
  await ctx.reply("Pick your daily reminder time:", { reply_markup: buildTimeKeyboard() });

  const timeCtx = await conversation.waitForCallbackQuery(/^time_/);
  await timeCtx.answerCallbackQuery();
  const reminderTime = timeCtx.callbackQuery.data.replace("time_", "");

  // ── Step 4 — Confirmation + DB save ──────────────────────────────────────
  const telegramId = BigInt(ctx.from!.id);
  const dbUser = await conversation.external(() =>
    prisma.user.update({
      where: { telegramId },
      data: {
        logFrequency: frequency,
        reminderTime,
        onboardingDone: true,
      },
    }),
  );

  await conversation.external(() =>
    createInitialReminderJobs(dbUser.id, telegramId, frequency, reminderTime, dbUser.timezone),
  );

  await sendScene(
    ctx,
    "scene4",
    `You're all set! 🎉\n\n` +
      `📅 *Frequency:* ${frequencyLabel(frequency)}\n` +
      `⏰ *Reminder time:* ${reminderTime}\n\n` +
      `Let's start logging your journey! 🚀`,
  );

  await ctx.reply("What would you like to do first?", {
    parse_mode: "Markdown",
    reply_markup: new InlineKeyboard()
      .text("📖 See my logs", "nav_logs")
      .text("✍️ Write today's log", "nav_write"),
  });

  // Render the persistent main menu keyboard
  await ctx.reply("Your main menu is ready 👇", { reply_markup: getMainMenuKeyboard(false) });
}

// ---------------------------------------------------------------------------
// /start handler — Step 1: register user + show welcome (registered in bot/index.ts)
// ---------------------------------------------------------------------------

export async function handleStart(ctx: BotContext) {
  clearActiveFlow(ctx.session);

  const telegramId = BigInt(ctx.from!.id);
  const firstName = ctx.from?.first_name ?? "friend";
  const username = ctx.from?.username;

  // Check for existing, fully-onboarded user
  const existing = await prisma.user.findUnique({ where: { telegramId } });

  if (existing?.onboardingDone) {
    await ctx.reply(`Welcome back, ${firstName}! 👋`, {
      reply_markup: getMainMenuKeyboard(hasActiveStorage(existing)),
    });
    return;
  }

  // Create or find the user record (without onboardingDone yet)
  if (!existing) {
    await prisma.user.create({
      data: {
        telegramId,
        firstName,
        username: username ?? null,
        logFrequency: "daily",   // placeholder; updated in conversation
        reminderTime: "09:00",   // placeholder; updated in conversation
      },
    });
  }

  // ── Step 1 — Welcome ──────────────────────────────────────────────────────
  await sendScene(
    ctx,
    "scene1",
    `Hey ${firstName}! 👋 I'm *Wisa* - your personal SIWES logbook assistant.\n\n` +
      `I'll remind you to write your daily industrial training log and help you make it shine ✨\n\n` +
      `Let's get you set up in under a minute!`,
  );

  await ctx.reply("Ready?", {
    reply_markup: new InlineKeyboard().text("Let's go! 🚀", "start_onboarding"),
  });
  // The conversation is entered when the user taps "Let's go!" (see handleLetsGo below)
}

export async function handleMenu(ctx: BotContext) {
  clearActiveFlow(ctx.session);

  const telegramId = BigInt(ctx.from!.id);
  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { id: true, firstName: true, isPro: true, storageUnlocked: true, logCount: true, nextRenewalDate: true },
  });

  await ctx.reply("Main menu 👇", {
    reply_markup: getMainMenuKeyboard(user ? hasActiveStorage(user) : false),
  });
}

/**
 * Callback handler for the "Let's go! 🚀" button.
 * Enters the onboarding conversation to proceed with steps 2–4.
 */
export async function handleLetsGo(ctx: BotContext) {
  await ctx.answerCallbackQuery();
  await ctx.conversation.enter("onboarding");
}
