import path from "path";
import fs from "fs";
import axios from "axios";
import { InlineKeyboard } from "grammy";
import os from "os";
import { parseISO } from "date-fns";
import { prisma } from "../lib/prisma";
import { refineLog, transcribeVoice } from "../services/openai";
import { captureReplayError } from "../services/replayCapture";
import type { BotContext } from "./types";
import { showAiComparisonChoice } from "./aiFlow";
import {
  canCreateLog,
  FREE_LOG_LIMIT,
  getStorageLimitReachedAfterSaveText,
  getMonetizationUserByTelegramId,
  hasActiveStorage,
  sendStorageWall,
} from "./monetization";
import { getMainMenuKeyboard } from "./onboarding";
import { handleCatchupFlowWithText } from "./catchupFlow";

// ---------------------------------------------------------------------------
// 8.2 — "✨ Refine with AI" handler (For text logs)
// ---------------------------------------------------------------------------

export async function handleAiRefine(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();

  const data = ctx.callbackQuery?.data ?? "";
  const logId = parseInt(data.replace("ai_refine_", ""), 10);
  if (isNaN(logId)) return;

  const telegramId = BigInt(ctx.from!.id);
  const dbUser = await prisma.user.findUnique({ where: { telegramId } });
  if (!dbUser) return;

  const unlocked = hasActiveStorage({
    id: dbUser.id,
    firstName: dbUser.firstName,
    isPro: dbUser.isPro,
    storageUnlocked: dbUser.storageUnlocked,
    logCount: dbUser.logCount,
    nextRenewalDate: dbUser.nextRenewalDate,
  });

  // ✅ FIX #5: CRITICAL — Check BEFORE the expensive API call
  if (!unlocked && dbUser.freeAiRefinements <= 0) {
    await ctx.reply(
      `✨ You've used all your free AI refinements!\n\n` +
        `Upgrade to *Pro* to unlock unlimited AI refinements, voice logs, and more 🚀`,
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard().text("Go Pro 👑", "go_pro"),
      },
    );
    return;
  }

  const log = await prisma.log.findUnique({ where: { id: logId } });
  if (!log || log.userId !== dbUser.id) {
    await ctx.reply("Couldn't find that log. 🤔");
    return;
  }

  console.log(`[ai-refine] User ${dbUser.id} refining log #${logId}`);

  const loadingMsg = await ctx.reply("✨ Refining your log...", {
    parse_mode: "Markdown",
  });

  try {
    const courseOfStudy = dbUser.courseOfStudy ?? "IT";
    const refined = await refineLog(log.content, courseOfStudy);

    // ✅ Decrement BEFORE showing the comparison (already checked above)
    if (!unlocked) {
      await prisma.user.update({
        where: { id: dbUser.id },
        data: { freeAiRefinements: { decrement: 1 } },
      });
    }

    // 👇 GUARANTEE SESSION STATE 👇
    ctx.session.pendingRawText = log.content;
    ctx.session.pendingRefinedText = refined;
    ctx.session.refiningLogId = logId;

    await showAiComparisonChoice(ctx, loadingMsg.message_id, log.content, refined);
  } catch (err) {
    console.error("AI refinement error:", err);
    captureReplayError(telegramId, err, "handleAiRefine", ctx.chat?.id);

    try {
      await prisma.log.update({
        where: { id: logId },
        data: {
          content: log.content,
          refinedContent: null,
          isAiRefined: false,
        },
      });
    } catch (saveErr) {
      console.error("Fallback save failed after AI error:", saveErr);
      captureReplayError(telegramId, saveErr, "handleAiRefine:fallbackSave", ctx.chat?.id);
    }

    ctx.session.pendingRawText = undefined;
    ctx.session.pendingRefinedText = undefined;
    ctx.session.pendingRefinedContent = undefined;
    ctx.session.refiningLogId = undefined;

    await ctx.api
      .editMessageText(
        ctx.chat!.id,
        loadingMsg.message_id,
        "Something went wrong while refining your log 😢 The AI is resting, but your original log has been saved safely.",
      )
      .catch(() => {});
    return;
  }
}

// ---------------------------------------------------------------------------
// Callback: save_ai_log — store the refined version after comparison
// ---------------------------------------------------------------------------

export async function handleSaveAiLog(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => {});

  const rawText = ctx.session.pendingRawText;
  const refinedText = ctx.session.pendingRefinedText;
  const logId = ctx.session.refiningLogId;
  const wasVoice = !!ctx.session.pendingVoiceTranscription;
  const wasFirstLog = ctx.session.awaitingFirstLog === true;

  // SRE FIX: Clear immediately to prevent double-tap races from reusing staged state.
  ctx.session.pendingRawText = undefined;
  ctx.session.pendingRefinedText = undefined;
  ctx.session.pendingRefinedContent = undefined;
  ctx.session.refiningLogId = undefined;
  ctx.session.pendingVoiceTranscription = undefined;
  ctx.session.awaitingLog = false;
  ctx.session.awaitingFirstLog = undefined;
  ctx.session.firstLogPromptSentAt = undefined;
  ctx.session.firstLogFollowUpSent = undefined;

  if (!rawText || !refinedText) {
    await ctx.reply("Session expired — please refine again.");
    return;
  }

  const navKeyboard = new InlineKeyboard()
    .text("📅 View calendar", "nav_calendar")
    .text("🏠 Menu", "nav_menu");

  try {
    const telegramId = BigInt(ctx.from!.id);
    const dbUser = await prisma.user.findUnique({ where: { telegramId } });
    if (!dbUser) {
      await ctx.reply("Couldn't find your account. Try /start.");
      return;
    }

    if (logId) {
      await prisma.log.update({
        where: { id: logId },
        data: {
          content: refinedText,
          refinedContent: null,
          isAiRefined: true,
        },
      });
    } else {
      const logDate = ctx.session.pendingLogDate ? parseISO(ctx.session.pendingLogDate) : new Date();
      await prisma.$transaction([
        prisma.log.create({
          data: {
            userId: dbUser.id,
            content: refinedText,
            refinedContent: null,
            logDate,
            isVoice: wasVoice,
            isAiRefined: true,
          },
        }),
        prisma.user.update({
          where: { id: dbUser.id },
          data: { logCount: { increment: 1 } },
        }),
      ]);
    }

    try {
      await ctx.editMessageText("✅ **Refined log saved!** 💾", {
        parse_mode: "Markdown",
        reply_markup: navKeyboard,
      });
    } catch (editErr) {
      const message = String((editErr as { message?: string })?.message ?? editErr);
      if (!message.includes("Message is not modified")) {
        console.error("Error editing AI save confirmation:", editErr);
      }
    }

    if (wasFirstLog && !logId) {
      await prisma.user.update({
        where: { id: dbUser.id },
        data: { firstLogCompletedInOnboarding: true },
      });
      await ctx.reply(
        `Your first log is saved! 🎉\n\n📒 I'll remind you tomorrow at ${dbUser.reminderTime} to keep going. Students who log consistently in their first week almost never fall behind before defense day.\n\nYou're off to a great start, ${dbUser.firstName} 💪`,
      );
      await ctx.reply("Here's your main menu 👇", {
        reply_markup: getMainMenuKeyboard(
          hasActiveStorage({
            id: dbUser.id,
            firstName: dbUser.firstName,
            isPro: dbUser.isPro,
            storageUnlocked: dbUser.storageUnlocked,
            logCount: dbUser.logCount,
            nextRenewalDate: dbUser.nextRenewalDate,
          }),
        ),
      });
    }
  } catch (err) {
    console.error("Error saving AI refined log:", err);
    await ctx.reply("Couldn't save the log. Please try again.");
  }
}

// ---------------------------------------------------------------------------
// Callback: save_raw_log — store the original version after comparison
// ---------------------------------------------------------------------------

export async function handleSaveRawLog(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery().catch(() => {});

  const rawText = ctx.session.pendingRawText;
  const refinedText = ctx.session.pendingRefinedText;
  const logId = ctx.session.refiningLogId;
  const wasVoice = !!ctx.session.pendingVoiceTranscription;
  const wasFirstLog = ctx.session.awaitingFirstLog === true;

  // SRE FIX: Clear immediately to prevent double-tap races from reusing staged state.
  ctx.session.pendingRawText = undefined;
  ctx.session.pendingRefinedText = undefined;
  ctx.session.pendingRefinedContent = undefined;
  ctx.session.refiningLogId = undefined;
  ctx.session.pendingVoiceTranscription = undefined;
  ctx.session.awaitingLog = false;
  ctx.session.awaitingFirstLog = undefined;
  ctx.session.firstLogPromptSentAt = undefined;
  ctx.session.firstLogFollowUpSent = undefined;

  if (!rawText || !refinedText) {
    await ctx.reply("Session expired — please refine again.");
    return;
  }

  const navKeyboard = new InlineKeyboard()
    .text("📅 View calendar", "nav_calendar")
    .text("🏠 Menu", "nav_menu");

  try {
    const telegramId = BigInt(ctx.from!.id);
    const dbUser = await prisma.user.findUnique({ where: { telegramId } });
    if (!dbUser) {
      await ctx.reply("Couldn't find your account. Try /start.");
      return;
    }

    if (logId) {
      await prisma.log.update({
        where: { id: logId },
        data: {
          content: rawText,
          refinedContent: null,
          isAiRefined: false,
        },
      });
    } else {
      const logDate = ctx.session.pendingLogDate ? parseISO(ctx.session.pendingLogDate) : new Date();
      await prisma.$transaction([
        prisma.log.create({
          data: {
            userId: dbUser.id,
            content: rawText,
            refinedContent: null,
            logDate,
            isVoice: wasVoice,
            isAiRefined: false,
          },
        }),
        prisma.user.update({
          where: { id: dbUser.id },
          data: { logCount: { increment: 1 } },
        }),
      ]);
    }

    try {
      await ctx.editMessageText("✅ **Original log saved!** 📝", {
        parse_mode: "Markdown",
        reply_markup: navKeyboard,
      });
    } catch (editErr) {
      const message = String((editErr as { message?: string })?.message ?? editErr);
      if (!message.includes("Message is not modified")) {
        console.error("Error editing raw save confirmation:", editErr);
      }
    }

    if (wasFirstLog && !logId) {
      await prisma.user.update({
        where: { id: dbUser.id },
        data: { firstLogCompletedInOnboarding: true },
      });
      await ctx.reply(
        `Your first log is saved! 🎉\n\n📒 I'll remind you tomorrow at ${dbUser.reminderTime} to keep going. Students who log consistently in their first week almost never fall behind before defense day.\n\nYou're off to a great start, ${dbUser.firstName} 💪`,
      );
      await ctx.reply("Here's your main menu 👇", {
        reply_markup: getMainMenuKeyboard(
          hasActiveStorage({
            id: dbUser.id,
            firstName: dbUser.firstName,
            isPro: dbUser.isPro,
            storageUnlocked: dbUser.storageUnlocked,
            logCount: dbUser.logCount,
            nextRenewalDate: dbUser.nextRenewalDate,
          }),
        ),
      });
    }
  } catch (err) {
    console.error("Error saving raw log:", err);
    await ctx.reply("Couldn't save the log. Please try again.");
  }
}

// ---------------------------------------------------------------------------
// 8.3 — Voice log handler (Direct to Auto-Refine)
// ---------------------------------------------------------------------------

export async function handleVoiceLog(ctx: BotContext): Promise<void> {
  // Intercept voice notes sent during an active catch-up brain dump
  const catchupState = ctx.session.catchup;
  const catchupBrainDumpPhases = ['awaiting_more_detail', 'awaiting_block_dump'] as const;
  const isBrainDumpPhase =
    catchupState?.active === true &&
    catchupBrainDumpPhases.includes(catchupState.step as typeof catchupBrainDumpPhases[number]);

  // Any other catch-up step (duration, anchor date, payment): voice is not valid
  // input, and falling through would save a stray daily log mid-flow. Text and
  // callbacks already have isolation guards; this is the matching one for voice.
  if (catchupState?.active === true && !isBrainDumpPhase) {
    await ctx.reply("Finish your catch-up or send /cancel before recording a voice log.");
    return;
  }

  if (isBrainDumpPhase) {
    const voice = ctx.message?.voice;
    if (!voice) return;

    const processingMsg = await ctx.reply("🎤 Got your voice note! Transcribing…");
    let localPath: string | null = null;

    try {
      const fileInfo = await ctx.api.getFile(voice.file_id);
      const filePath = fileInfo.file_path!;
      const downloadUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${filePath}`;

      const tempDir = os.tmpdir();
      if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
      localPath = path.join(tempDir, `${voice.file_id}.ogg`);

      const response = await axios.get<ArrayBuffer>(downloadUrl, { responseType: "arraybuffer" });
      fs.writeFileSync(localPath, Buffer.from(response.data));

      const transcription = await transcribeVoice(localPath);

      if (!transcription) {
        await ctx.api.editMessageText(
          ctx.chat!.id,
          processingMsg.message_id,
          "🎤 Oops, it sounded a bit noisy! Try recording again in a quieter spot, or just type it out.",
        ).catch(() => {});
        return;
      }

      // Delete the transcribing message then hand off to the catch-up text handler
      await ctx.api.deleteMessage(ctx.chat!.id, processingMsg.message_id).catch(() => {});
      await handleCatchupFlowWithText(ctx, transcription);
    } catch (err) {
      console.error("Voice transcription error (catch-up intercept):", err);
      await ctx.api.editMessageText(
        ctx.chat!.id,
        processingMsg.message_id,
        "Something went wrong transcribing your voice note 😢 Please try again or type it out.",
      ).catch(() => {});
    } finally {
      if (localPath && fs.existsSync(localPath)) fs.unlinkSync(localPath);
    }
    return;
  }

  if (catchupState?.active === true && catchupState.step === 'awaiting_course') {
    await ctx.reply("Just type your area of study and we'll continue from there 👇");
    return;
  }

  if (
    catchupState?.active === true &&
    (catchupState.step === 'awaiting_start_date' || catchupState.step === 'awaiting_end_date')
  ) {
    await ctx.reply("You're picking your dates right now 📅 — just tap the calendar to select them.");
    return;
  }

  if (!ctx.session.awaitingLog) {
    await ctx.reply(
      "🎤 You sent a voice note, but you aren't currently writing a log!\n\nTo use voice logging, tap **✍️ Write my log** from the menu or a reminder first.",
      { parse_mode: "Markdown" }
    );
    return;
  }

  const telegramId = BigInt(ctx.from!.id);
  const dbUser = await prisma.user.findUnique({ where: { telegramId } });
  if (!dbUser) return;

  const monetizationUser = await getMonetizationUserByTelegramId(telegramId);
  if (!monetizationUser) return;

  if (!canCreateLog(monetizationUser)) {
    await sendStorageWall(ctx, monetizationUser);
    return;
  }

  const unlocked = hasActiveStorage(monetizationUser);

  if (!unlocked && dbUser.freeVoiceLogs <= 0) {
    await ctx.reply(
      `🎤 You've used all 5 of your free voice logs!\n\n` + // 🚀 Bumped to 5
        `Voice logging is *so* much faster than typing — upgrade to *Pro* for unlimited voice-to-log transcription ✨`,
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard().text("Go Pro 👑", "go_pro"),
      },
    );
    return;
  }

  const awaitingFirstLog = ctx.session.awaitingFirstLog;

  const voice = ctx.message?.voice;
  if (!voice) return;

  const processingMsg = await ctx.reply("🎤 Got your voice note! Transcribing… _(hang tight)_", {
    parse_mode: "Markdown",
  });

  let localPath: string | null = null;

  try {
    const fileInfo = await ctx.api.getFile(voice.file_id);
    const filePath = fileInfo.file_path!;
    const downloadUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${filePath}`;

    const tempDir = os.tmpdir();
    if (!fs.existsSync(tempDir)) {
      fs.mkdirSync(tempDir, { recursive: true });
    }
    localPath = path.join(tempDir, `${voice.file_id}.ogg`);

    const response = await axios.get<ArrayBuffer>(downloadUrl, { responseType: "arraybuffer" });
    fs.writeFileSync(localPath, Buffer.from(response.data));

    const transcription = await transcribeVoice(localPath);

    // 🚀 THE GRACEFUL FAILSAFE
    if (!transcription) {
      await ctx.api
        .editMessageText(
          ctx.chat!.id,
          processingMsg.message_id,
          "🎤 Oops, it sounded a bit noisy in the background! Can you type it out for me, or try recording again in a quieter spot?",
        )
        .catch(() => {});
      return;
    }

    ctx.session.pendingVoiceTranscription = transcription;

    if (!dbUser.courseOfStudy) {
      ctx.session.awaitingCourseForVoice = true;
      await ctx.api.editMessageText(
        ctx.chat!.id,
        processingMsg.message_id,
        "🎤 Transcription complete!\n\nBefore I refine this into a professional log, what is your **Course of Study**? (e.g., Computer Science, Accounting)\n\n_Please type it below:_",
        { parse_mode: "Markdown" }
      ).catch(() => {});
      return;
    }

    await ctx.api.editMessageText(
      ctx.chat!.id,
      processingMsg.message_id,
      "🎤 Voice transcribed! ✨ Refining your log...",
    ).catch(() => {});

    const refined = await refineLog(transcription, dbUser.courseOfStudy);

    if (!unlocked) {
      await prisma.user.update({
        where: { id: dbUser.id },
        data: { freeVoiceLogs: { decrement: 1 } },
      });
    }

    ctx.session.pendingRawText = transcription;
    ctx.session.pendingRefinedText = refined;
    ctx.session.refiningLogId = undefined;
    ctx.session.awaitingFirstLog = awaitingFirstLog;

    await showAiComparisonChoice(ctx, processingMsg.message_id, transcription, refined);

  } catch (err) {
    console.error("Voice transcription/refinement error:", err);
    captureReplayError(telegramId, err, "handleVoiceLog", ctx.chat?.id);
    await ctx.api
      .editMessageText(
        ctx.chat!.id,
        processingMsg.message_id,
        "Something went wrong while processing your voice note 😢 Please try again.",
      )
      .catch(() => {});
  } finally {
    if (localPath && fs.existsSync(localPath)) fs.unlinkSync(localPath);
  }
}

// ---------------------------------------------------------------------------
// 8.4 — Voice Resume (Called when user replies with their Course of Study)
// ---------------------------------------------------------------------------
export async function continueVoiceRefinementAfterCourse(ctx: BotContext, courseOfStudy: string): Promise<void> {
  const awaitingFirstLog = ctx.session.awaitingFirstLog;

  const telegramId = BigInt(ctx.from!.id);
  const transcription = ctx.session.pendingVoiceTranscription;

  ctx.session.awaitingCourseForVoice = false;

  if (!transcription) {
    await ctx.reply("Session expired. Please send your voice note again.");
    return;
  }

  const dbUser = await prisma.user.update({
    where: { telegramId },
    data: { courseOfStudy },
  });

  const monetizationUser = await getMonetizationUserByTelegramId(telegramId);
  if (!monetizationUser) return;
  const unlocked = hasActiveStorage(monetizationUser);

  const loadingMsg = await ctx.reply("✨ Got it! Refining your voice log...", { parse_mode: "Markdown" });

  try {
    const refined = await refineLog(transcription, courseOfStudy);

    if (!unlocked) {
      await prisma.user.update({
        where: { id: dbUser.id },
        data: { freeVoiceLogs: { decrement: 1 } },
      });
    }

    ctx.session.pendingRawText = transcription;
    ctx.session.pendingRefinedText = refined;
    ctx.session.refiningLogId = undefined;
    ctx.session.awaitingFirstLog = awaitingFirstLog;

    await showAiComparisonChoice(ctx, loadingMsg.message_id, transcription, refined);
  } catch (err) {
    console.error("Auto-refinement error after course:", err);
    captureReplayError(telegramId, err, "continueVoiceRefinementAfterCourse", ctx.chat?.id);
    await ctx.api.editMessageText(
      ctx.chat!.id,
      loadingMsg.message_id,
      "Something went wrong while refining your log 😢 Please try again."
    ).catch(() => {});
  }
}