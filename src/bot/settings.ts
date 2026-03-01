import { InlineKeyboard } from "grammy";
import { type BotContext } from "./types";
import { prisma } from "../lib/prisma";
import { buildTimeKeyboard, createInitialReminderJobs, MAIN_MENU_KEYBOARD } from "./onboarding";

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

  const user = await prisma.user.update({
    where: { telegramId },
    data: { reminderTime },
  });

  // Replace all pending jobs with a fresh schedule at the new time
  await prisma.reminderJob.deleteMany({ where: { userId: user.id, status: "pending" } });
  await createInitialReminderJobs(user.id, telegramId, user.logFrequency, reminderTime, user.timezone);

  await ctx.reply(
    `Done! ✅ Your reminder time is now *${reminderTime}* ⏰\n\nNew reminder schedule created 🗓️`,
    { parse_mode: "Markdown", reply_markup: SETTINGS_BACK_KB },
  );
}

// ---------------------------------------------------------------------------
// 📅 Change log frequency
// ---------------------------------------------------------------------------

export async function handleSettingsFreq(ctx: BotContext) {
  await ctx.answerCallbackQuery();
  await ctx.reply("📅 How often do you want to log?", {
    reply_markup: new InlineKeyboard()
      .text("Every day", "stg_freq_daily")
      .text("Every 2 days", "stg_freq_bi-daily").row()
      .text("Every 3 days", "stg_freq_every-3-days")
      .text("Once a week", "stg_freq_weekly"),
  });
}

export async function handleSettingsFreqSelect(ctx: BotContext) {
  await ctx.answerCallbackQuery();
  const logFrequency = (ctx.callbackQuery?.data ?? "").replace("stg_freq_", "");
  const telegramId = BigInt(ctx.from!.id);

  const user = await prisma.user.update({
    where: { telegramId },
    data: { logFrequency },
  });

  // Replace all pending jobs with a fresh schedule at the same reminder time
  await prisma.reminderJob.deleteMany({ where: { userId: user.id, status: "pending" } });
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

  const user = await prisma.user.findUnique({
    where: { telegramId },
    include: { subscription: true },
  });

  if (!user) return;

  if (!user.isPro || !user.subscription) {
    await ctx.reply(
      `👑 *Subscription Status*\n\n` +
        `You're currently on the *Free* plan.\n\n` +
        `Free users get:\n` +
        `• 3 AI log refinements\n` +
        `• Text logs only\n\n` +
        `Upgrade to *Pro* for:\n` +
        `• Unlimited AI refinements ✨\n` +
        `• Voice-to-log transcription 🎙️\n` +
        `• ₦5,000/month`,
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard()
          .text("👑 Upgrade to Pro", "pay_paystack").row()
          .text("🏠 Menu", "nav_menu"),
      },
    );
    return;
  }

  const sub = user.subscription;
  const isActive = sub.status === "active" && sub.endDate > new Date();
  const endStr = sub.endDate.toLocaleDateString("en-NG", {
    day: "numeric",
    month: "long",
    year: "numeric",
  });

  const statusLine = isActive ? "✅ Active" : sub.status === "cancelled" ? "🚫 Cancelled" : "❌ Expired";

  await ctx.reply(
    `👑 *Subscription Status*\n\n` +
      `Plan: *Pro*\n` +
      `Status: ${statusLine}\n` +
      `${isActive ? "Renews" : "Access until"}: *${endStr}*\n` +
      `Reference: \`${sub.paystackRef}\``,
    {
      parse_mode: "Markdown",
      reply_markup: isActive
        ? new InlineKeyboard()
            .text("❌ Cancel subscription", "settings_cancel_sub").row()
            .text("🏠 Menu", "nav_menu")
        : new InlineKeyboard()
            .text("🔄 Renew Pro", "pay_paystack").row()
            .text("🏠 Menu", "nav_menu"),
    },
  );
}

export async function handleCancelSubPrompt(ctx: BotContext) {
  await ctx.answerCallbackQuery();
  await ctx.reply(
    "⚠️ Are you sure you want to cancel your Pro subscription?\n\n" +
      "You'll keep Pro access until the end of your current billing period, then revert to Free.",
    {
      reply_markup: new InlineKeyboard()
        .text("Yes, cancel ❌", "settings_cancel_sub_confirm")
        .text("Keep Pro 👑", "settings_sub"),
    },
  );
}

export async function handleCancelSubConfirm(ctx: BotContext) {
  await ctx.answerCallbackQuery();
  const telegramId = BigInt(ctx.from!.id);

  const user = await prisma.user.findUnique({
    where: { telegramId },
    include: { subscription: true },
  });

  if (user?.subscription) {
    await prisma.subscription.update({
      where: { id: user.subscription.id },
      data: { status: "cancelled" },
    });
  }

  await ctx.reply(
    `Your Pro subscription has been cancelled 😢\n\n` +
      `You'll retain Pro access until the end of your current billing period. ` +
      `We hope to see you back soon — your logs will be waiting! 🙏`,
    { reply_markup: new InlineKeyboard().text("🏠 Menu", "nav_menu") },
  );
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
      `Tap "Write today's log", type your work activities (send as many messages as you like), then tap *Done ✅*. Wisa saves everything automatically.\n\n` +
      `*⏰ Reminders*\n` +
      `Wisa nudges you at your chosen time to write your log. Snooze up to 3 times — on the 3rd you get the final push 😄\n\n` +
      `*✨ AI Refinement*\n` +
      `After saving a log, tap "Refine with AI" to polish your entry into professional, supervisor-ready language. Free users get 3 refinements; Pro users get unlimited.\n\n` +
      `*🎙️ Voice logs (Pro only)*\n` +
      `Send a voice message and Wisa transcribes it and saves it as a log entry.\n\n` +
      `*📅 Calendar*\n` +
      `Browse all your logs by day. Tap any marked day to view, edit, delete, or refine a log.\n\n` +
      `*👑 Pro plan — ₦5,000/month*\n` +
      `Unlimited AI refinements + voice-to-log transcription.\n\n` +
      `Questions? We're always here 🙏`,
    {
      parse_mode: "Markdown",
      reply_markup: SETTINGS_BACK_KB,
    },
  );
}
