import path from "path";
import fs from "fs";
import axios from "axios";
import { InlineKeyboard } from "grammy";
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

// ---------------------------------------------------------------------------
// 8.2 — "✨ Refine with AI" handler
// Callback data: ai_refine_<logId>
// ---------------------------------------------------------------------------

/**
 * Entry point for AI refinement.
 * - Checks free refinement quota (or Pro status)
 * - Sends a loading message, calls OpenAI, then replaces with the result
 * - Presents [✅ Use this version] [Keep original 📝]
 */
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

  // ── Gate: free quota check ──────────────────────────────────────────────
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

  // ── Loading message ─────────────────────────────────────────────────────
  const loadingMsg = await ctx.reply("✨ Refining your log...", {
    parse_mode: "Markdown",
  });

  try {
    const courseOfStudy = dbUser.courseOfStudy ?? "IT";
    const refined = await refineLog(log.content, courseOfStudy);

    ctx.session.refiningLogId = logId;

    await showAiComparisonChoice(ctx, loadingMsg.message_id, log.content, refined);

    // Decrement free quota for non-Pro users
    if (!unlocked) {
      await prisma.user.update({
        where: { id: dbUser.id },
        data: { freeAiRefinements: { decrement: 1 } },
      });
    }
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

  // Clear immediately to prevent double-tap races from reusing staged state.
  ctx.session.pendingRawText = undefined;
  ctx.session.pendingRefinedText = undefined;
  ctx.session.pendingRefinedContent = undefined;
  ctx.session.refiningLogId = undefined;

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
          refinedContent: rawText,
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
            refinedContent: rawText,
            logDate,
            isVoice: false,
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

  // Clear immediately to prevent double-tap races from reusing staged state.
  ctx.session.pendingRawText = undefined;
  ctx.session.pendingRefinedText = undefined;
  ctx.session.pendingRefinedContent = undefined;
  ctx.session.refiningLogId = undefined;

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
          refinedContent: refinedText,
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
            refinedContent: refinedText,
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
  } catch (err) {
    console.error("Error saving raw log:", err);
    await ctx.reply("Couldn't save the log. Please try again.");
  }
}

// ---------------------------------------------------------------------------
// 8.3 — Voice log handler (Pro only)
// Triggered on ctx.message.voice
// ---------------------------------------------------------------------------

export async function handleVoiceLog(ctx: BotContext): Promise<void> {
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

  // ── Free voice quota check ───────────────────────────────────────────────
  if (!unlocked && dbUser.freeVoiceLogs <= 0) {
    await ctx.reply(
      `🎤 You've used all 3 of your free voice logs!\n\n` +
        `Voice logging is *so* much faster than typing — upgrade to *Pro* for unlimited voice-to-log transcription ✨`,
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard().text("Go Pro 👑", "go_pro"),
      },
    );
    return;
  }

  const voice = ctx.message?.voice;
  if (!voice) return;

  // Log voice message metadata
  console.log(`[handleVoiceLog] User ${telegramId} sent voice message:`);
  console.log(`[handleVoiceLog] - file_id: ${voice.file_id}`);
  console.log(`[handleVoiceLog] - duration: ${voice.duration}s`);
  console.log(`[handleVoiceLog] - file_size: ${voice.file_size} bytes (${(voice.file_size! / 1024 / 1024).toFixed(2)} MB)`);
  console.log(`[handleVoiceLog] - mime_type: ${voice.mime_type}`);

  const processingMsg = await ctx.reply("🎤 Got your voice note! Transcribing… _(hang tight)_", {
    parse_mode: "Markdown",
  });

  let localPath: string | null = null;

  try {
    // 1. Resolve download URL via Telegram API
    const fileInfo = await ctx.api.getFile(voice.file_id);
    const filePath = fileInfo.file_path!;
    const downloadUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${filePath}`;
    console.log(`[handleVoiceLog] Downloaded file URL path: ${filePath}`);

    // 2. Download OGG to /tmp
    localPath = path.join("/tmp", `${voice.file_id}.ogg`);
    const response = await axios.get<ArrayBuffer>(downloadUrl, { responseType: "arraybuffer" });
    fs.writeFileSync(localPath, Buffer.from(response.data));
    const downloadedSize = fs.statSync(localPath).size;
    console.log(`[handleVoiceLog] File downloaded to ${localPath}, size: ${downloadedSize} bytes`);

    // 3. Transcribe with Whisper
    console.log(`[handleVoiceLog] Calling transcribeVoice()...`);
    const transcription = await transcribeVoice(localPath);
    console.log(`[handleVoiceLog] transcribeVoice returned: ${transcription ? `SUCCESS (${transcription.length} chars)` : 'NULL'}`);

    // 3a. Handle silent/unclear audio
    if (!transcription) {
      console.log(`[handleVoiceLog] ❌ Transcription was null - sending error message to user`);
      await ctx.api
        .editMessageText(
          ctx.chat!.id,
          processingMsg.message_id,
          "🎤 I couldn't make out anything from that audio. Please re-record in a quiet environment and speak clearly.",
        )
        .catch(() => {});
      return;
    }

    const remainingNote =
      !unlocked && dbUser.freeVoiceLogs > 1
        ? `\n\n_${dbUser.freeVoiceLogs - 1} free voice log${dbUser.freeVoiceLogs - 1 !== 1 ? "s" : ""} remaining — upgrade to Pro for unlimited 🚀_`
        : !unlocked && dbUser.freeVoiceLogs === 1
        ? `\n\n_This was your last free voice log! Upgrade to Pro for unlimited 🚀_`
        : "";

    // 4. Store in session for save/edit callbacks
    ctx.session.pendingVoiceTranscription = transcription;

    // 5. Show result with action buttons
    await ctx.api.editMessageText(
      ctx.chat!.id,
      processingMsg.message_id,
      `🎤 *Here's what I heard:*

${transcription}${remainingNote}`,
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard()
          .text("✅ Save this log", "voice_save")
          .row()
          .text("✏️ Edit before saving", "voice_edit")
          .text("🔄 Re-record", "voice_rerecord"),
      },
    );
  } catch (err) {
    console.error("Voice transcription error:", err);
    captureReplayError(telegramId, err, "handleVoiceLog", ctx.chat?.id);
    await ctx.api
      .editMessageText(
        ctx.chat!.id,
        processingMsg.message_id,
        "Something went wrong while transcribing your voice note 😢 Please try again.",
      )
      .catch(() => {});
  } finally {
    // Clean up temp file
    if (localPath && fs.existsSync(localPath)) {
      fs.unlinkSync(localPath);
    }
  }
}

// ---------------------------------------------------------------------------
// Callback: voice_save — save the transcription as today's log
// ---------------------------------------------------------------------------

export async function handleVoiceSave(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();

  const transcription = ctx.session.pendingVoiceTranscription;

  // Clear immediately to prevent double-tap races from reusing staged state.
  ctx.session.pendingVoiceTranscription = undefined;

  if (!transcription) {
    await ctx.reply("Session expired — please send your voice message again.");
    return;
  }

  const telegramId = BigInt(ctx.from!.id);
  const monetizationUser = await getMonetizationUserByTelegramId(telegramId);
  if (!monetizationUser) return;

  if (!canCreateLog(monetizationUser)) {
    await sendStorageWall(ctx, monetizationUser);
    return;
  }

  try {
    const [savedLog, updatedUser] = await prisma.$transaction([
      prisma.log.create({
        data: {
          userId: monetizationUser.id,
          content: transcription,
          logDate: new Date(),
          isVoice: true,
          isAiRefined: false,
        },
      }),
      prisma.user.update({
        where: { id: monetizationUser.id },
        data: { logCount: { increment: 1 } },
        select: {
          id: true,
          firstName: true,
          isPro: true,
          storageUnlocked: true,
          logCount: true,
          nextRenewalDate: true,
        },
      }),
    ]);

    await ctx.editMessageText("Saving your voice log\u2026 🎙️").catch(() => {});

    if (!hasActiveStorage(updatedUser) && updatedUser.logCount === FREE_LOG_LIMIT) {
      await ctx.reply(getStorageLimitReachedAfterSaveText(), {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard().text("🔓 Unlock storage - ₦1,000", "go_pro"),
      });
      return;
    }

    await ctx.reply("What would you like to do next?", {
      reply_markup: new InlineKeyboard()
        .text("✨ Refine with AI", `ai_refine_${savedLog.id}`)
        .row()
        .text("📖 View logs", "nav_calendar")
        .text("🏠 Menu", "nav_menu"),
    });
  } catch (err) {
    console.error("Error saving voice log:", err);
    captureReplayError(telegramId, err, "handleVoiceSave", ctx.chat?.id);
    await ctx.reply("Couldn't save the log. Please try again. 😢");
  }
}

// ---------------------------------------------------------------------------
// Callback: voice_edit — pre-fill transcription, hand off to edit flow
// ---------------------------------------------------------------------------

export async function handleVoiceEdit(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();

  const transcription = ctx.session.pendingVoiceTranscription;
  if (!transcription) {
    await ctx.reply("Session expired — please send your voice message again.");
    return;
  }

  // Clear the voice session, but open the text logging session
  ctx.session.awaitingLog = true;
  ctx.session.pendingVoiceTranscription = undefined;
  
  // Make sure we clear out any old draft arrays just to be safe
  ctx.session.pendingLogParts = [];

  await ctx.reply(
    `✏️ To edit, just **copy** the text above, make your changes, and send it back to me. I'll automatically refine the new version! ✨`,
    {
      parse_mode: "Markdown",
    },
  );
}

// ---------------------------------------------------------------------------
// Callback: voice_rerecord — prompt the user to try again
// ---------------------------------------------------------------------------

export async function handleVoiceRerecord(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();

  ctx.session.pendingVoiceTranscription = undefined;

  await ctx.editMessageText(
    "No problem! 🔄 Send me another voice message whenever you're ready 🎤",
  ).catch(() => {});
}
