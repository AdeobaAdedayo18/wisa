import { InlineKeyboard } from "grammy";
import { type BotContext } from "./types";
import { prisma } from "../lib/prisma";
import { captureReplayError } from "../services/replayCapture";
import { buildTimeKeyboard, createInitialReminderJobs } from "./onboarding";
import { hasActiveStorage, STORAGE_PRICE_LABEL } from "./monetization";
import { disableSubscription } from "../services/paystack";

// ---------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------

const FREQ_LABELS: Record<string, string> = {
  daily: "Every day",
  "bi-daily": "Every 2 days",
  "every-3-days": "Every 3 days",
  weekly: "Once a week",
};

const SETTINGS_BACK_KB = new InlineKeyboard()
  .text("⚙️ Back to Settings", "settings_menu")
  .text("🏠 Menu", "nav_menu");

// ---------------------------------------------------------------------------
// ⚙️ Settings main menu
// ---------------------------------------------------------------------------

async function sendSettingsMenu(ctx: BotContext) {
  await ctx.reply("⚙️ *Settings*\n\nWhat would you like to change?", {
    parse_mode: "Markdown",
    reply_markup: new InlineKeyboard()
      .text("⏰ Change reminder time", "settings_time").row()
      .text("📅 Change log frequency", "settings_freq").row()
      .text("👑 Manage subscription", "settings_sub").row()
      .text("❓ How this works", "settings_how").row()
      .text("🏠 Back to menu", "nav_menu"),
  });
}

/** Triggered by the "⚙️ Settings" reply keyboard button. */
export async function handleSettings(ctx: BotContext) {
  await sendSettingsMenu(ctx);
}

/** Triggered by the "⚙️ Back to Settings" inline callback. */
export async function handleSettingsMenu(ctx: BotContext) {
  await ctx.answerCallbackQuery();
  await sendSettingsMenu(ctx);
}

// ---------------------------------------------------------------------------
// ⏰ Change reminder time
// ---------------------------------------------------------------------------

export async function handleSettingsTime(ctx: BotContext) {
  await ctx.answerCallbackQuery();
  await ctx.reply("⏰ Pick your new reminder time:", {
    reply_markup: buildTimeKeyboard("stg_time_"),
  });
}

export async function handleSettingsTimeSelect(ctx: BotContext) {
  await ctx.answerCallbackQuery();
  const reminderTime = (ctx.callbackQuery?.data ?? "").replace("stg_time_", "");
  const telegramId = BigInt(ctx.from!.id);
  try {
  const user = await prisma.user.update({
    where: { telegramId },
    data: { reminderTime },
  });

  // Replace all pending AND stale sent jobs with a fresh schedule at the new time
  await prisma.reminderJob.deleteMany({
    where: { userId: user.id, status: { in: ["pending", "sent"] } },
  });
  await createInitialReminderJobs(user.id, telegramId, user.logFrequency, reminderTime, user.timezone);

  await ctx.reply(
    `Done! ✅ Your reminder time is now *${reminderTime}* ⏰\n\nNew reminder schedule created 🗓️`,
    { parse_mode: "Markdown", reply_markup: SETTINGS_BACK_KB },
  );
  } catch (err) {
    console.error("[settings] handleSettingsTimeSelect error:", err);
    captureReplayError(telegramId, err, "handleSettingsTimeSelect", ctx.chat?.id);
    await ctx.reply("Couldn't update your settings. Please try again 😢");
  }
}

// ---------------------------------------------------------------------------
// 📅 Change log frequency
// ---------------------------------------------------------------------------

export async function handleSettingsFreq(ctx: BotContext) {
  await ctx.answerCallbackQuery();
  const telegramId = BigInt(ctx.from!.id);
  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { logFrequency: true },
  });

  if (!user) {
    await ctx.reply("Couldn't find your account. Try /start.");
    return;
  }

  const isBiDaily = user.logFrequency === "bi-daily";
  const nextFreqLabel = isBiDaily ? "Daily" : "Every 2 Days";
  const nextCallback = isBiDaily ? "set_freq_daily" : "set_freq_2days";

  await ctx.reply(
    `📅 *Change log frequency*\n\nYou're currently on *${FREQ_LABELS[user.logFrequency] ?? user.logFrequency}*.`,
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard()
        .text(`Switch to ${nextFreqLabel}`, nextCallback)
        .row()
        .text("⚙️ Back to Settings", "settings_menu")
        .text("🏠 Menu", "nav_menu"),
    },
  );
}

async function updateFrequencyAndReschedule(
  ctx: BotContext,
  logFrequency: "daily" | "bi-daily",
): Promise<void> {
  await ctx.answerCallbackQuery();
  const telegramId = BigInt(ctx.from!.id);

  const user = await prisma.user.update({
    where: { telegramId },
    data: { logFrequency },
  });

  // Replace all pending AND stale sent jobs with a fresh schedule at the same reminder time
  await prisma.reminderJob.deleteMany({
    where: { userId: user.id, status: { in: ["pending", "sent"] } },
  });
  await createInitialReminderJobs(user.id, telegramId, logFrequency, user.reminderTime, user.timezone);

  const cadenceText = logFrequency === "daily" ? "day" : "2 days";
  await ctx.reply(
    `Done! I'll now remind you every ${cadenceText}. 🗓️`,
    { reply_markup: SETTINGS_BACK_KB },
  );
}

export async function handleSettingsFreqDaily(ctx: BotContext): Promise<void> {
  await updateFrequencyAndReschedule(ctx, "daily");
}

export async function handleSettingsFreq2Days(ctx: BotContext): Promise<void> {
  await updateFrequencyAndReschedule(ctx, "bi-daily");
}

export async function handleSettingsFreqSelect(ctx: BotContext) {
  await ctx.answerCallbackQuery();
  const logFrequency = (ctx.callbackQuery?.data ?? "").replace("stg_freq_", "");
  const telegramId = BigInt(ctx.from!.id);

  const user = await prisma.user.update({
    where: { telegramId },
    data: { logFrequency },
  });

  // Replace all pending AND stale sent jobs with a fresh schedule at the same reminder time
  await prisma.reminderJob.deleteMany({
    where: { userId: user.id, status: { in: ["pending", "sent"] } },
  });
  await createInitialReminderJobs(user.id, telegramId, logFrequency, user.reminderTime, user.timezone);

  await ctx.reply(
    `Done! ✅ Log frequency updated to *${FREQ_LABELS[logFrequency] ?? logFrequency}* 📅\n\nNew reminder schedule created 🗓️`,
    { parse_mode: "Markdown", reply_markup: SETTINGS_BACK_KB },
  );
}

// ---------------------------------------------------------------------------
// 👑 Manage subscription
// ---------------------------------------------------------------------------

export async function handleSettingsSub(ctx: BotContext) {
  await ctx.answerCallbackQuery();
  const telegramId = BigInt(ctx.from!.id);

  const user = await prisma.user.findUnique({ where: { telegramId } });

  if (!user) return;

  if (!hasActiveStorage(user)) {
    await ctx.reply(
      `👑 *Storage Plan Status*\n\n` +
        `You're currently on the *Free* plan.\n\n` +
        `Free users get:\n` +
        `• 3 AI refinements\n` +
        `• 3 voice logs\n\n` +
        `Unlock storage for ${STORAGE_PRICE_LABEL} to get:\n` +
        `• Unlimited log storage 📦\n` +
        `• Unlimited AI refinements ✨\n` +
        `• Unlimited voice logs 🎙️`,
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard()
          .text("🔓 Unlock storage", "go_pro").row()
          .text("🏠 Menu", "nav_menu"),
      },
    );
    return;
  }

  const endStr = user.nextRenewalDate?.toLocaleDateString("en-NG", {
    day: "numeric",
    month: "long",
    year: "numeric",
  }) ?? "Not set";

  await ctx.reply(
    `👑 *Storage Plan Status*\n\n` +
      `Plan: *Unlocked*\n` +
      `Status: ✅ Active\n` +
      `Renews on: *${endStr}*\n` +
      `Price: *${STORAGE_PRICE_LABEL}*`,
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard()
        .text("❌ Stop Using Wisa", "settings_cancel_sub").row() // 👈 Added the Cancel button!
        .text("🏠 Menu", "nav_menu"),
    },
  );
}

// DRAMA STEP 1
export async function handleCancelSubPrompt(ctx: BotContext) {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    "Are you sure you want to stop using Wisa? 🥺\n\nYour logbook is going to miss you...",
    {
      reply_markup: new InlineKeyboard()
        .text("Yes, cancel it.", "cancel_sub_2")
        .row()
        .text("No, I'm staying! ❤️", "nav_menu"),
    }
  );
}

// DRAMA STEP 2
export async function handleCancelSubPrompt2(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  await ctx.editMessageText(
    "Are you really really really really sure? 😢",
    {
      reply_markup: new InlineKeyboard()
        .text("Yes, I'm sure.", "settings_cancel_sub_confirm")
        .row()
        .text("Okay fine, I'll stay! 😭", "nav_menu"),
    }
  );
}

// DRAMA STEP 3 - FINAL CANCELLATION
export async function handleCancelSubConfirm(ctx: BotContext) {
  await ctx.answerCallbackQuery();
  const telegramId = BigInt(ctx.from!.id);

  try {
    const user = await prisma.user.findUnique({
      where: { telegramId },
      include: { subscription: true },
    });

    if (!user) return;

    // Tell Paystack to cancel future billing
    if (user.paymentEmail) {
      await disableSubscription(user.paymentEmail);
    }

    // Mark subscription as cancelled in the database
    if (user.subscription) {
      await prisma.subscription.update({
        where: { id: user.subscription.id },
        data: { status: "cancelled" },
      });
    }

    // NOTE: We do NOT set storageUnlocked to false here! 
    // They keep their Pro access until `nextRenewalDate` is reached.

    await ctx.editMessageText(
      "Alright... if you don't value your logbook you can cancel 😭😭\n\n" +
      "*(Your auto-renewal has been cancelled. You won't be billed again, but you can keep using your Pro features until your current month runs out).* 💔",
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard().text("🏠 Back to Menu", "nav_menu"),
      }
    );
  } catch (err) {
    console.error("[settings] handleCancelSubConfirm error:", err);
    await ctx.editMessageText(
      "Something went wrong trying to cancel. Please try again or use the link in your email receipt!", 
      { reply_markup: new InlineKeyboard().text("🏠 Back to Menu", "nav_menu") }
    );
  }
}

// ---------------------------------------------------------------------------
// ❓ How this works
// ---------------------------------------------------------------------------

export async function handleSettingsHow(ctx: BotContext) {
  await ctx.answerCallbackQuery();
  await ctx.reply(
    `❓ *How Wisa Works*\n\n` +
      `Wisa is your personal SIWES logbook assistant 📓\n\n` +
      `*✍️ Writing logs*\n` +
      `Tap "Write today's log", send your log, and Wisa will refine it automatically.\n\n` +
      `*⏰ Reminders*\n` +
      `Wisa nudges you at your chosen time to write your log. Snooze up to 3 times — on the 3rd you get the final push 😄\n\n` +
      `*✨ AI Refinement*\n` +
      `After saving a log, tap "Refine with AI" to polish your entry into professional, supervisor-ready language. Free users get 3 refinements.\n\n` +
      `*🎙️ Voice logs*\n` +
      `Free users get 3 voice logs. Unlock storage to remove limits.\n\n` +
      `*📅 Calendar*\n` +
      `Browse all your logs by day. Tap any marked day to view, edit, delete, or refine a log.\n\n` +
      `*🔓 Storage plan — ₦1,000/month*\n` +
      `Unlocks unlimited storage + unlimited AI refinements + unlimited voice logs.\n\n` +
      `Questions? We're always here 🙏`,
    {
      parse_mode: "Markdown",
      reply_markup: SETTINGS_BACK_KB,
    },
  );
}