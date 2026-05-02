import { Bot, InlineKeyboard, session } from "grammy";
import { replayMiddleware, replayTransformer, captureReplayError } from "../services/replayCapture";
import { conversations, createConversation } from "@grammyjs/conversations";
import { PrismaAdapter } from "@grammyjs/storage-prisma";
import { prisma } from "../lib/prisma";
import { parseISO } from "date-fns";
import { refineLog } from "../services/openai";
import { onboardingConversation, handleStart, handleLetsGo, handleMenu, getMainMenuKeyboard } from "./onboarding";
import { handleSnooze, handleSkip, handleWriteFromReminder, scheduleNextJob } from "./reminders";
import {
  startLogging,
  handleLogText,
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
  handleSaveAiLog,
  handleSaveRawLog,
  handleVoiceLog,
  handleVoiceSave,
  handleVoiceEdit,
  handleVoiceRerecord,
} from "./aiFeatures";
import { showAiComparisonChoice } from "./aiFlow";
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
  handleSettingsFreqDaily,
  handleSettingsFreq2Days,
  handleSettingsFreqSelect,
  handleSettingsSub,
  handleCancelSubPrompt,
  handleCancelSubConfirm,
  handleSettingsHow,
} from "./settings";
import { handleFeedback, handleFeedbackText, handleFeedbackCancel } from "./feedback";
import { clearActiveFlow, type SessionData, type BotContext } from "./types";
import { FREE_LOG_LIMIT, getMonetizationUserByTelegramId, getStorageLimitReachedAfterSaveText, hasActiveStorage } from "./monetization";

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
bot.command("cancel", async (ctx) => {
  clearActiveFlow(ctx.session);
  await ctx.reply("Flow cancelled.");
});

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
bot.callbackQuery("save_ai_log", handleSaveAiLog);
bot.callbackQuery("save_raw_log", handleSaveRawLog);

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
bot.callbackQuery("set_freq_daily", handleSettingsFreqDaily);
bot.callbackQuery("set_freq_2days", handleSettingsFreq2Days);
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
bot.callbackQuery(/^resume_write_log_\d{4}-\d{2}-\d{2}$/, async (ctx) => {
  await ctx.answerCallbackQuery();
  const data = ctx.callbackQuery?.data ?? "";
  const isoDate = data.replace("resume_write_log_", "");
  return startLogging(ctx, isoDate);
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
  return handleMenu(ctx);
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

  const telegramId = BigInt(ctx.from!.id);
  const dbUser = await prisma.user.findUnique({
    where: { telegramId },
    select: {
      id: true,
      firstName: true,
      isPro: true,
      storageUnlocked: true,
      logCount: true,
      nextRenewalDate: true,
      freeAiRefinements: true,
      courseOfStudy: true,
    },
  });

  if (ctx.session.awaitingCourse) {
    const incomingText = ctx.message?.text ?? "";
    const trimmedText = incomingText.trim();

    if (incomingText.startsWith("/")) {
      ctx.session.awaitingCourse = false;
      ctx.session.draftLogForCourse = undefined;
      return;
    }

    if (trimmedText.length < 2) {
      await ctx.reply("Please enter a valid Course of Study so I can personalize your logs!");
      return;
    }

    if (!dbUser) return;

    const draft = ctx.session.draftLogForCourse ?? "";
    if (!draft.trim()) {
      ctx.session.awaitingCourse = false;
      ctx.session.draftLogForCourse = undefined;
      await ctx.reply("Something went wrong picking up your draft. Please start your log again.");
      return;
    }

    await prisma.user.update({
      where: { id: dbUser.id },
      data: { courseOfStudy: trimmedText },
    });

    ctx.session.awaitingCourse = false;
    ctx.session.draftLogForCourse = undefined;
    ctx.session.awaitingLog = false;
    ctx.session.pendingLogParts = [];
    ctx.session.lastLogMessageAt = undefined;
    ctx.session.autoSavePromptSent = undefined;
    ctx.session.flowStartedAt = undefined;

    const unlocked = hasActiveStorage(dbUser);

    // ── Gate: AI Quota Check with Graceful Fallback ──
    if (!unlocked && dbUser.freeAiRefinements <= 0) {
      // Fallback: Do they still have standard storage space?
      if (dbUser.logCount < FREE_LOG_LIMIT) {
        const logDate = ctx.session.pendingLogDate ? parseISO(ctx.session.pendingLogDate) : new Date();
        await prisma.$transaction([
          prisma.log.create({
            data: {
              userId: dbUser.id,
              content: draft, // Use the raw text input here
              logDate,
              isVoice: false,
              isAiRefined: false,
            },
          }),
          prisma.user.update({
            where: { id: dbUser.id },
            data: { logCount: { increment: 1 } },
          }),
        ]);

        ctx.session.awaitingLog = false;
        ctx.session.pendingLogParts = [];
        ctx.session.pendingRawText = undefined;
        ctx.session.pendingRefinedText = undefined;
        ctx.session.pendingVoiceTranscription = undefined;
        ctx.session.refiningLogId = undefined;

        // THE PERFECT UI: Combined Message & Keyboard
        const combinedKeyboard = new InlineKeyboard()
          .text("👑 Go Pro - ₦1,000", "go_pro")
          .row()
          .text("📅 View calendar", "nav_calendar")
          .text("🏠 Menu", "nav_menu");

        await ctx.reply(
          `✅ **Original log saved!** 📝\n\n` +
            `✨ _Heads up: You've used all 3 free AI refinements._\n` +
            `Upgrade to **Pro** to unlock unlimited AI refinements and keep your logs looking pristine 🚀`,
          { parse_mode: "Markdown", reply_markup: combinedKeyboard },
        );
      } else {
        // Out of both AI and Storage quotas
        await ctx.reply(getStorageLimitReachedAfterSaveText(), {
          parse_mode: "Markdown",
          reply_markup: new InlineKeyboard().text("🔓 Unlock storage - ₦1,000", "go_pro"),
        });
      }
      return;
    }

    const loadingMsg = await ctx.reply("✨ Refining your log...", { parse_mode: "Markdown" });

    try {
      const refinedText = await refineLog(draft, trimmedText);
      await showAiComparisonChoice(ctx, loadingMsg.message_id, draft, refinedText);

      return;
    } catch (err) {
      console.error("[course-interceptor] AI refinement failed:", err);
      captureReplayError(BigInt(ctx.from!.id), err, "courseInterceptor:refineLog", ctx.chat?.id);

      try {
        const logDate = ctx.session.pendingLogDate ? new Date(ctx.session.pendingLogDate) : new Date();
        await prisma.$transaction([
          prisma.log.create({
            data: {
              userId: dbUser.id,
              content: draft,
              refinedContent: null,
              logDate,
              isVoice: false,
              isAiRefined: false,
            },
          }),
          prisma.user.update({
            where: { id: dbUser.id },
            data: { logCount: { increment: 1 } },
          }),
        ]);
      } catch (saveErr) {
        console.error("[course-interceptor] Fallback save failed:", saveErr);
        captureReplayError(BigInt(ctx.from!.id), saveErr, "courseInterceptor:fallbackSave", ctx.chat?.id);
      }

      ctx.session.pendingRawText = undefined;
      ctx.session.pendingRefinedText = undefined;
      ctx.session.pendingRefinedContent = undefined;

      await ctx.api.editMessageText(
        ctx.chat!.id,
        loadingMsg.message_id,
        "Something went wrong while refining your log 😢 The AI is resting, but your original log has been saved safely.",
      ).catch(() => {});
      return;
    }
  }

  if (ctx.session.awaitingLog && !dbUser?.courseOfStudy) {
    ctx.session.awaitingCourse = true;
    ctx.session.draftLogForCourse = ctx.message?.text ?? "";
    await ctx.reply("✨ I'd love to AI-refine this for you! But to make it perfect for your logbook, what is your Area of Study?");
    return;
  }

  if (ctx.session.awaitingLog && dbUser?.courseOfStudy) {
    if (await handleLogText(ctx, dbUser)) return;
  }
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
