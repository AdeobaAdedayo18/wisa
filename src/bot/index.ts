import { Bot, session } from "grammy";
import { replayMiddleware, replayTransformer, captureReplayError } from "../services/replayCapture";
import { conversations, createConversation } from "@grammyjs/conversations";
import { PrismaAdapter } from "@grammyjs/storage-prisma";
import { prisma } from "../lib/prisma";
import { onboardingConversation, handleStart, handleLetsGo, getMainMenuKeyboard } from "./onboarding";
import { handleSnooze, handleSkip, handleWriteFromReminder, scheduleNextJob } from "./reminders";
import {
  startLogging,
  handleLogText,
  handleDoneLogging,
  handleEditLog,
  handleEditText,
  showPastLogCalendar,
  handlePastCalNav,
  handlePastLogDateSelect,
  handleAutoSaveConfirm,
  handleAutoSaveContinue,
} from "./logging";
import {
  showViewCalendar,
  handleViewCalNav,
  handleViewCalDateSelect,
  handleDeleteLogPrompt,
  handleDeleteLogConfirm,
  handleDeleteLogCancel,
} from "./calendar";
import {
  handleAiRefine,
  handleUseRefined,
  handleKeepOriginal,
  handleVoiceLog,
  handleVoiceSave,
  handleVoiceEdit,
  handleVoiceRerecord,
} from "./aiFeatures";
import {
  handleGoPro,
  handlePayPaystack,
  handleCheckPayment,
  handlePayManual,
  handleManualSent,
  handleAdminApprove,
  handleAdminReject,
  handlePaymentEmailText,
} from "./payments";
import {
  handleSettings,
  handleSettingsMenu,
  handleSettingsTime,
  handleSettingsTimeSelect,
  handleSettingsFreq,
  handleSettingsFreqSelect,
  handleSettingsSub,
  handleCancelSubPrompt,
  handleCancelSubConfirm,
  handleSettingsHow,
} from "./settings";
import { handleFeedback, handleFeedbackText, handleFeedbackCancel } from "./feedback";
import { type SessionData, type BotContext } from "./types";
import { getMonetizationUserByTelegramId, hasActiveStorage } from "./monetization";

export type { SessionData, BotContext };

export const bot = new Bot<BotContext>(process.env.TELEGRAM_BOT_TOKEN!);
//To rollback comment the next 2 lines of code
// ── Replay capture (MUST be before session middleware) ───────────────────────
bot.use(replayMiddleware());

// ── Outgoing API call capture via Transformer ────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
bot.api.config.use(replayTransformer as any);

// Session middleware backed by Prisma/PostgreSQL
bot.use(session({
  initial: (): SessionData => ({ awaitingLog: false, pendingLogParts: [] }),
  storage: new PrismaAdapter<SessionData>(prisma.session),
}));
bot.use(conversations());

// ── Conversations ──────────────────────────────────────────────────────────
bot.use(createConversation(onboardingConversation, "onboarding"));

// ── Bot-unblock recovery ───────────────────────────────────────────────────
// If a user previously blocked the bot but then comes back, clear the flag
// and re-queue their reminders so they start receiving them again.
bot.use(async (ctx, next) => {
  if (ctx.from) {
    const user = await prisma.user.findUnique({
      where: { telegramId: BigInt(ctx.from.id) },
      select: { id: true, telegramId: true, botBlocked: true, onboardingDone: true },
    });
    if (user?.botBlocked) {
      await prisma.user.update({ where: { id: user.id }, data: { botBlocked: false } });
      if (user.onboardingDone) {
        await scheduleNextJob(user.id, user.telegramId);
      }
      console.log(`[bot] User ${user.id} unblocked the bot — reminders re-enabled`);
    }
  }
  return next();
});

// ── Command handlers ───────────────────────────────────────────────────────
bot.command("start", handleStart);

// ── Reply keyboard — main menu ─────────────────────────────────────────────
// Use regex so emoji encoding changes from formatters don't break matching
bot.hears(/Write today.s log/i, (ctx) => startLogging(ctx));
bot.hears(/See my logs/i, (ctx) => showViewCalendar(ctx));
bot.hears(/Leave feedback/i, handleFeedback);
bot.hears(/AI Refine/i, (ctx) => showViewCalendar(ctx));
bot.hears(/Go Pro/i, handleGoPro);
bot.hears(/Settings/i, handleSettings);

// ── Callback query handlers ────────────────────────────────────────────────
bot.callbackQuery("start_onboarding", handleLetsGo);
bot.callbackQuery(/^snooze_\d+$/, handleSnooze);
bot.callbackQuery(/^skip_\d+$/, handleSkip);

// Logging flow
bot.callbackQuery(/^write_log_\d+_\d{4}-\d{2}-\d{2}$/, handleWriteFromReminder);
bot.callbackQuery("write_log", (ctx) => startLogging(ctx));
bot.callbackQuery("done_log", handleDoneLogging);
bot.callbackQuery("auto_save_confirm", handleAutoSaveConfirm);
bot.callbackQuery("auto_save_continue", handleAutoSaveContinue);
bot.callbackQuery(/^edit_log_\d+$/, handleEditLog);

// Past-log calendar (6.4)
bot.callbackQuery(/^cal_nav_\d+_\d+$/, handlePastCalNav);
bot.callbackQuery("cal_noop", (ctx) => ctx.answerCallbackQuery());
bot.callbackQuery(/^past_log_\d{4}-\d{2}-\d{2}$/, handlePastLogDateSelect);

// View calendar (7.1 / 7.2)
bot.callbackQuery(/^vcal_nav_\d+_\d+$/, handleViewCalNav);
bot.callbackQuery(/^view_cal_\d{4}-\d{2}-\d{2}$/, handleViewCalDateSelect);

// Delete flow (7.3)
bot.callbackQuery(/^delete_log_\d+$/, handleDeleteLogPrompt);
bot.callbackQuery(/^delete_confirm_\d+$/, handleDeleteLogConfirm);
bot.callbackQuery("delete_cancel", handleDeleteLogCancel);

// AI refinement flow (8.2)
bot.callbackQuery(/^ai_refine_\d+$/, handleAiRefine);
bot.callbackQuery(/^ai_use_refined_\d+$/, handleUseRefined);
bot.callbackQuery(/^ai_keep_original_\d+$/, handleKeepOriginal);

// Voice log flow (8.3)
bot.callbackQuery("voice_save", handleVoiceSave);
bot.callbackQuery("voice_edit", handleVoiceEdit);
bot.callbackQuery("voice_rerecord", handleVoiceRerecord);

// Payments / Pro upgrade flow (9.2)
bot.callbackQuery("go_pro", handleGoPro);
bot.callbackQuery("pay_paystack", handlePayPaystack);
bot.callbackQuery("check_payment", handleCheckPayment);
bot.callbackQuery("pay_manual", handlePayManual);
bot.callbackQuery("manual_sent", handleManualSent);
bot.callbackQuery(/^mpay_approve_\d+$/, handleAdminApprove);
bot.callbackQuery(/^mpay_reject_\d+$/, handleAdminReject);

// Settings flow (11)
bot.callbackQuery("settings_menu", handleSettingsMenu);
bot.callbackQuery("settings_time", handleSettingsTime);
bot.callbackQuery(/^stg_time_\d{2}:\d{2}$/, handleSettingsTimeSelect);
bot.callbackQuery("settings_freq", handleSettingsFreq);
bot.callbackQuery(/^stg_freq_/, handleSettingsFreqSelect);
bot.callbackQuery("settings_sub", handleSettingsSub);
bot.callbackQuery("settings_cancel_sub", handleCancelSubPrompt);
bot.callbackQuery("settings_cancel_sub_confirm", handleCancelSubConfirm);
bot.callbackQuery("settings_how", handleSettingsHow);

// Feedback flow
bot.callbackQuery("feedback_cancel", handleFeedbackCancel);

// Keep-active (10)
bot.callbackQuery("keepalive", async (ctx) => {
  await ctx.answerCallbackQuery("Thanks for checking in! 👋");
  const user = await getMonetizationUserByTelegramId(BigInt(ctx.from!.id));
  await ctx.reply("Great to see you! 😊 Keep those logs coming 📝", {
    reply_markup: getMainMenuKeyboard(user ? hasActiveStorage(user) : false),
  });
});

// Navigation shortcuts
bot.callbackQuery("nav_write", async (ctx) => {
  await ctx.answerCallbackQuery();
  return startLogging(ctx);
});
bot.callbackQuery("nav_calendar", async (ctx) => {
  await ctx.answerCallbackQuery();
  return showViewCalendar(ctx);
});
bot.callbackQuery("weekly_nav_calendar", async (ctx) => {
  await ctx.answerCallbackQuery();
  return showViewCalendar(ctx, undefined, undefined, { mode: "reply" });
});
bot.callbackQuery("nav_logs", async (ctx) => {
  await ctx.answerCallbackQuery();
  return showViewCalendar(ctx);
});
bot.callbackQuery("nav_past_log", async (ctx) => {
  await ctx.answerCallbackQuery();
  return showPastLogCalendar(ctx);
});
bot.callbackQuery("weekly_nav_past_log", async (ctx) => {
  await ctx.answerCallbackQuery();
  return showPastLogCalendar(ctx, undefined, undefined, { mode: "reply" });
});
bot.callbackQuery("nav_menu", async (ctx) => {
  await ctx.answerCallbackQuery();
  const user = await getMonetizationUserByTelegramId(BigInt(ctx.from!.id));
  await ctx.reply("Main menu 👇", {
    reply_markup: getMainMenuKeyboard(user ? hasActiveStorage(user) : false),
  });
});

// ── Voice message handler (8.3) ──────────────────────────────────────────
bot.on("message:voice", handleVoiceLog);

// ── Text message handler — session-aware routing ──────────────────────────
bot.on("message:text", async (ctx) => {
  // Feedback capture takes highest priority
  if (await handleFeedbackText(ctx)) return;
  // Payment email capture
  if (await handlePaymentEmailText(ctx)) return;
  // Edit mode takes priority over log accumulation
  if (await handleEditText(ctx)) return;
  if (await handleLogText(ctx)) return;
  // Fall through — other text messages not handled here
});

// ── Global error boundary ─────────────────────────────────────────────────
bot.catch((err) => {
  const ctx = err.ctx;
  const telegramId = ctx.from?.id ?? 0;
  console.error(`[bot] Unhandled error for user ${telegramId}:`, err.error);

  captureReplayError(
    BigInt(telegramId),
    err.error,
    `bot.catch:${err.message}`,
    ctx.chat?.id,
  );
});
