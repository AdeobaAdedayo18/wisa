import { Bot, InlineKeyboard, session } from "grammy";
import { replayMiddleware, replayTransformer, captureReplayError } from "../services/replayCapture";
import { conversations, createConversation } from "@grammyjs/conversations";
import { createSessionStorage } from "./sessionStorage";
import { prisma } from "../lib/prisma";
import { parseISO, differenceInDays } from "date-fns";
import { localTimeToUtc } from "../utils/dateHelpers";
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
  handleViewLogNavigation,
  handleDeleteLogPrompt,
  handleDeleteLogConfirm,
  handleDeleteLogCancel,
} from "./calendar";
import {
  handleAiRefine,
  handleSaveAiLog,
  handleSaveRawLog,
  handleVoiceLog,
  continueVoiceRefinementAfterCourse,
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
  handleCancelSubPrompt2, // 🚀 ADDED IMPORT HERE
  handleCancelSubConfirm,
  handleSettingsHow,
} from "./settings";
import { handleFeedback, handleFeedbackText, handleFeedbackCancel } from "./feedback";
import { clearActiveFlow, type SessionData, type BotContext } from "./types";
import { FREE_LOG_LIMIT, getMonetizationUserByTelegramId, getStorageLimitReachedAfterSaveText, hasActiveStorage } from "./monetization";

// 🚀 IMPORT THE CATCH-UP ENGINE & CALENDAR HANDLERS
import {
  startCatchupFlow,
  handleCatchupFlow,
  handleCatchupCallback,
  handleFastTrackReminderCallback,
  FAST_TRACK_REMINDER_PATTERN,
} from "./catchupFlow";

export type { SessionData, BotContext };

export const bot = new Bot<BotContext>(process.env.TELEGRAM_BOT_TOKEN!);
//To rollback comment the next 2 lines of code
// ── Replay capture (MUST be before session middleware) ───────────────────────
bot.use(replayMiddleware());

// ── Outgoing API call capture via Transformer ────────────────────────────────
// eslint-disable-next-line @typescript-eslint/no-explicit-any
bot.api.config.use(replayTransformer as any);

// Session middleware backed by Prisma/PostgreSQL.
// The storage adapter merges out-of-band catch-up patches on write-back — see
// ./sessionStorage — so webhook fulfilment is not clobbered by in-flight updates.
bot.use(session({
  initial: (): SessionData => ({ awaitingLog: false, pendingLogParts: [] }),
  storage: createSessionStorage(),
}));
bot.use(conversations());

// ── Conversations ──────────────────────────────────────────────────────────
bot.use(createConversation(onboardingConversation, "onboarding"));

// ── Catch-up fast track (deep link) ────────────────────────────────────────
// Registered HERE, ahead of the dormant-welcome middleware below, and not with
// the other commands further down. A `?start=catchup…` user has never onboarded
// and has no logs, so the dormant branch would greet them with "Welcome back —
// ready to pick up where you left off?" before the catch-up flow ever ran.
//
// Ordinary /start falls through via next() to the handler registered later.

/** Deep-link payloads are `catchup` plus an optional attribution suffix. */
function readCatchupDeepLink(match: unknown): string | null {
  if (typeof match !== "string") return null;
  const payload = match.trim();
  return payload.toLowerCase().startsWith("catchup") ? payload : null;
}

bot.command("start", async (ctx, next) => {
  const deepLink = readCatchupDeepLink(ctx.match);

  // Block other /start variants mid-flow (previously FIX #9).
  if (ctx.session.catchup?.active && !deepLink) {
    await ctx.reply("You're in the middle of Catch-Up Mode! Tap 'Cancel' in the calendar or type /cancel to exit.");
    return;
  }

  if (!deepLink) return next();

  const telegramId = BigInt(ctx.from!.id);
  const dbUser = await prisma.user.findUnique({ where: { telegramId } });

  if (!dbUser) {
    // Created WITHOUT workplaceRole so the catch-up flow's interceptor asks for
    // it — that value now drives the field-of-study constraint on the LLM.
    await prisma.user.create({
      data: {
        telegramId,
        firstName: ctx.from?.first_name || "Student",
        onboardingDone: true, // Bypass normal onboarding
        logFrequency: "daily",
        reminderTime: "18:00",
        workplaceRole: null,
      },
    });
  }

  // Set BEFORE startCatchupFlow, which calls clearActiveFlow — that helper
  // deliberately leaves these two keys alone (see ./types).
  ctx.session.isCatchupFastTrack = true;
  ctx.session.catchupEntrySource = deepLink;

  return startCatchupFlow(ctx);
});

// ── Bot-unblock recovery + returning-dormant detection ────────────────────
// Single middleware to handle both cases with one DB round-trip per request.
//
// Bot-unblock: if a user who previously blocked the bot interacts again,
// clear the flag and restore their reminder schedule.
//
// Returning dormant: if an onboarded user who has been silent for 3+ days
// (and hasn't been contacted in the last 3 days) interacts, send a welcome
// message and immediately reschedule their reminder to their normal cadence.
const DORMANT_WELCOME_COOLDOWN_MS = 3 * 24 * 60 * 60 * 1000; // 3 days

bot.use(async (ctx, next) => {
  if (!ctx.from) return next();

  const telegramId = BigInt(ctx.from.id);
  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: {
      id: true,
      telegramId: true,
      botBlocked: true,
      onboardingDone: true,
      firstName: true,
      lastContactedAt: true,
      reminderTime: true,
      timezone: true,
      createdAt: true,
    },
  });

  if (!user) return next();

  // ── Bot-unblock ──
  if (user.botBlocked) {
    await prisma.user.update({ where: { id: user.id }, data: { botBlocked: false } });
    if (user.onboardingDone) {
      await scheduleNextJob(user.id, user.telegramId);
    }
    console.log(`[bot] User ${user.id} unblocked the bot — reminders re-enabled`);
    return next();
  }

  // ── Returning-dormant detection ──
  // Only applies to fully onboarded users. Gate with lastContactedAt first to
  // avoid running a log query on every request from an active user.
  if (user.onboardingDone) {
    const msSinceContacted = user.lastContactedAt
      ? Date.now() - user.lastContactedAt.getTime()
      : Infinity;

    if (msSinceContacted > DORMANT_WELCOME_COOLDOWN_MS) {
      const lastLog = await prisma.log.findFirst({
        where: { userId: user.id },
        orderBy: { logDate: "desc" },
        select: { logDate: true },
      });

      const daysSinceLastLog = lastLog
        ? differenceInDays(new Date(), lastLog.logDate)
        : differenceInDays(new Date(), user.createdAt);

      if (daysSinceLastLog > 3) {
        // User is returning from the dormant window — welcome them back and
        // immediately reschedule their reminder to their normal cadence.
        try {
          await ctx.reply(
            `Welcome back ${user.firstName} 👋 — ready to pick up where you left off?`,
            { reply_markup: { inline_keyboard: [[{ text: "Write today's log ✍️", callback_data: "write_log" }]] } }
          );
        } catch {
          // Non-fatal — proceed even if the welcome message fails
        }

        // Reschedule to their normal reminder time (today if upcoming, else tomorrow)
        if (user.reminderTime && user.timezone) {
          try {
            const candidateToday = localTimeToUtc(user.reminderTime, user.timezone, 0);
            const nextReminderTime =
              candidateToday > new Date()
                ? candidateToday
                : localTimeToUtc(user.reminderTime, user.timezone, 1);
            await scheduleNextJob(user.id, user.telegramId, nextReminderTime);
          } catch {
            // Fall back to default scheduling if time computation fails
            await scheduleNextJob(user.id, user.telegramId);
          }
        } else {
          await scheduleNextJob(user.id, user.telegramId);
        }

        await prisma.user.update({
          where: { id: user.id },
          data: { lastContactedAt: new Date() },
        });
      }
    }
  }

  return next();
});

// ── Command handlers ───────────────────────────────────────────────────────
// Ordinary /start only. The `?start=catchup…` deep link and the mid-flow guard
// are handled by the earlier bot.command("start") near the top of this file,
// which calls next() for everything else.
bot.command("start", handleStart);

// ✅ FIX #9: Allow /cancel to exit catch-up cleanly
bot.command("cancel", async (ctx) => {
  if (ctx.session.catchup?.active) {
    clearActiveFlow(ctx.session);
    await ctx.reply("Catch-up cancelled. Let me know when you're ready! 🏠", {
      reply_markup: new InlineKeyboard().text("🏠 Menu", "nav_menu")
    });
    return;
  }
  clearActiveFlow(ctx.session);
  await ctx.reply("Flow cancelled.");
});

// 🚀 REGISTER CATCH-UP COMMAND
bot.command("catchup", startCatchupFlow);

// ── Text message handler — session-aware routing (MOVED TO TOP FOR ISOLATION) ──
bot.on("message:text", async (ctx, next) => {
  // ✅ GLOBAL MENU ESCAPE HATCH: Exit flows when user taps main menu buttons
  const text = ctx.message?.text?.trim() || "";
  
  // Anchored pattern: allows leading/trailing non-alphanumeric chars (emojis, spaces) but requires
  // the keyword to be the ENTIRE content — prevents "go pro" from matching inside a sentence.
  const mainMenuPattern = /^[^a-zA-Z0-9]*(write today.?s log|see my logs|leave feedback|ai refine|go pro|settings|catch up missed days)[^a-zA-Z0-9]*$/i;
  
  // 🚀 THE FIX: If user taps ANY menu button, instantly kill all active flows
  if (mainMenuPattern.test(text)) {
    clearActiveFlow(ctx.session);
    ctx.session.awaitingLog = false;
    ctx.session.awaitingCourse = false;
    ctx.session.awaitingCourseForVoice = false;
    return next(); // Skip the AI logic entirely and pass the button tap to the menu handlers below!
  }

  // 🚀 CATCH-UP FLOW INTERCEPTOR 🚀
  // Routes text input directly to the catch-up state machine if active
  if (ctx.session.catchup?.active) {
    await handleCatchupFlow(ctx);
    return;
  }

  // Feedback capture takes highest priority
  if (await handleFeedbackText(ctx)) return;
  // Payment email capture
  if (await handlePaymentEmailText(ctx)) return;
  // Edit mode takes priority over log accumulation
  if (await handleEditText(ctx)) return;

  // ── Voice Course Interceptor ──
  if (ctx.session.awaitingCourseForVoice) {
    if (!ctx.message.text) return;
    return continueVoiceRefinementAfterCourse(ctx, ctx.message.text);
  }

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
      workplaceRole: true,
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
      await ctx.reply("Please enter a valid job role so I can personalize your logs!");
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
      data: { workplaceRole: trimmedText },
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
            `✨ _Heads up: You've used all 5 free AI refinements._\n` + // 🚀 Bumped to 5
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

      // 🚀 THE GATEKEEPER INTERCEPTOR (Course Flow)
      if (refinedText.startsWith("REJECTED:")) {
        await ctx.api.deleteMessage(ctx.chat!.id, loadingMsg.message_id).catch(() => {});
        
        // Reset their state so they can try writing the log again
        ctx.session.awaitingCourse = false;
        ctx.session.draftLogForCourse = undefined;
        ctx.session.awaitingLog = true;
        
        await ctx.reply(
          "Nice try! 😂 But I actually need to know what you worked on. Tell me a bit about your tasks! (Try sending a slightly longer message or a voice note)."
        );
        return; // Stop execution here!
      }

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

  if (ctx.session.awaitingLog && !dbUser?.workplaceRole) {
    ctx.session.awaitingCourse = true;
    ctx.session.draftLogForCourse = ctx.message?.text ?? "";
    await ctx.reply("I'd love to refine this for you! But to make it perfect for your logbook, what is your job role?");
    return;
  }

  if (ctx.session.awaitingLog && dbUser?.workplaceRole) {
    if (await handleLogText(ctx, dbUser)) return;
  }
  
  // Fall through — other text messages pass to next middleware
  return next();
});

// ── Reply keyboard — main menu ─────────────────────────────────────────────
// ✅ Use strict anchors (^ $) so emoji and normal text don't interfere
bot.hears(/^✍️\s*Write today.?s log$/i, (ctx) => {
  if (ctx.session.catchup?.active) return; // 🚀 Isolation Guard
  return startLogging(ctx);
});
bot.hears(/^📖\s*See my logs$/i, (ctx) => showViewCalendar(ctx));
bot.hears(/^💬\s*Leave feedback$/i, handleFeedback);
bot.hears(/^✨\s*AI Refine$/i, (ctx) => showViewCalendar(ctx));
bot.hears(/^👑\s*Go Pro$/i, handleGoPro);

// ✅ Fixed: Settings uses strict anchors with emoji to prevent false matches
bot.hears(/^⚙️\s*Settings$/i, handleSettings);

bot.hears(/^[^a-zA-Z0-9]*catch up missed days[^a-zA-Z0-9]*$/i, startCatchupFlow);

// ── Callback query handlers ────────────────────────────────────────────────
bot.callbackQuery("start_onboarding", handleLetsGo);
bot.callbackQuery(/^snooze_\d+$/, handleSnooze);
bot.callbackQuery(/^skip_\d+$/, handleSkip);

// 🚀 CATCHUP TRIGGER FROM INLINE BUTTONS (Reminders / Weekly Recap)
bot.callbackQuery("trigger_catchup", startCatchupFlow);

// 🚀 ROUTE CALENDAR CLICKS TO CATCHUP HANDLER
bot.callbackQuery(/^(ccal_|catchup_|cdur_)/, handleCatchupCallback);

// Post-catchup bridge: the reminder setup offered to fast-track users once
// their backlog is generated. Own `ftrem_` prefix so it cannot collide with the
// onboarding conversation's `time_` picker or Settings' `stg_time_` one.
bot.callbackQuery(FAST_TRACK_REMINDER_PATTERN, handleFastTrackReminderCallback);

// Logging flow
bot.callbackQuery(/^write_log_\d+_\d{4}-\d{2}-\d{2}$/, handleWriteFromReminder);
bot.callbackQuery("write_log", (ctx) => {
  if (ctx.session.catchup?.active) return ctx.answerCallbackQuery("Please finish or /cancel catch-up first!");
  return startLogging(ctx);
});
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

// ✅ NEW: Chronological log navigation (7.2b)
bot.callbackQuery(/^view_log_nav_\d+$/, handleViewLogNavigation);

// Delete flow (7.3)
bot.callbackQuery(/^delete_log_\d+$/, handleDeleteLogPrompt);
bot.callbackQuery(/^delete_confirm_\d+$/, handleDeleteLogConfirm);
bot.callbackQuery("delete_cancel", handleDeleteLogCancel);

// AI refinement flow (8.2)
bot.callbackQuery(/^ai_refine_\d+$/, handleAiRefine);
bot.callbackQuery("save_ai_log", handleSaveAiLog);
bot.callbackQuery("save_raw_log", handleSaveRawLog);

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
bot.callbackQuery("cancel_sub_2", handleCancelSubPrompt2); // 🚀 ADDED ROUTE HERE
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
  if (ctx.session.catchup?.active) return ctx.answerCallbackQuery("Please finish catch-up first!");
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


// ── Set Native Bot Commands ────────────────────────────────────────────────
// Exposes the blue "Menu" button natively in Telegram
bot.api.setMyCommands([
  { command: "start", description: "Restart Wisa" },
  { command: "catchup", description: "🔄 Fill in missed SIWES days" },
  { command: "cancel", description: "Cancel what you are currently doing" },
]).catch((err) => console.error("Failed to set commands:", err));