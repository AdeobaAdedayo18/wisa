import path from "path";
import fs from "fs";
import axios from "axios";
import { InlineKeyboard } from "grammy";
import { prisma } from "../lib/prisma";
import { refineLog, transcribeVoice } from "../services/openai";
import type { BotContext } from "./types";

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

  // ── Gate: free quota check ──────────────────────────────────────────────
  if (!dbUser.isPro && dbUser.freeAiRefinements <= 0) {
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
  const loadingMsg = await ctx.reply("Let me cook 🍳✨ _(this may take a few seconds…)_", {
    parse_mode: "Markdown",
  });

  try {
    const refined = await refineLog(log.content);

    // Store refined content in session so the confirm handler can use it
    ctx.session.refiningLogId = logId;
    ctx.session.pendingRefinedContent = refined;

    // Replace loading message with the result
    await ctx.api.editMessageText(
      ctx.chat!.id,
      loadingMsg.message_id,
      `✨ *Here's the refined version:*\n\n${refined}`,
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard()
          .text("✅ Use this version", `ai_use_refined_${logId}`)
          .text("Keep original 📝", `ai_keep_original_${logId}`),
      },
    );

    // Decrement free quota for non-Pro users
    if (!dbUser.isPro) {
      await prisma.user.update({
        where: { id: dbUser.id },
        data: { freeAiRefinements: { decrement: 1 } },
      });
    }
  } catch (err) {
    console.error("AI refinement error:", err);
    await ctx.api
      .editMessageText(
        ctx.chat!.id,
        loadingMsg.message_id,
        "Something went wrong while refining your log 😢 Please try again.",
      )
      .catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Callback: ai_use_refined_<logId>  — user accepts the refined version
// ---------------------------------------------------------------------------

export async function handleUseRefined(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();

  const data = ctx.callbackQuery?.data ?? "";
  const logId = parseInt(data.replace("ai_use_refined_", ""), 10);

  const refinedContent = ctx.session.pendingRefinedContent;
  if (!refinedContent || ctx.session.refiningLogId !== logId) {
    await ctx.reply("Session expired — please tap ✨ Refine again.");
    return;
  }

  try {
    await prisma.log.update({
      where: { id: logId },
      data: { refinedContent },
    });

    // Clear session
    ctx.session.pendingRefinedContent = undefined;
    ctx.session.refiningLogId = undefined;

    await ctx.editMessageText(
      `✅ *Refined version saved!* Your log is looking legendary 👑\n\n${refinedContent}`,
      { parse_mode: "Markdown" },
    ).catch(() => {});

    await ctx.reply("Refined log saved! 💾", {
      reply_markup: new InlineKeyboard()
        .text("📅 View calendar", "nav_calendar")
        .text("🏠 Menu", "nav_menu"),
    });
  } catch (err) {
    console.error("Error saving refined log:", err);
    await ctx.reply("Couldn't save the refined log. Please try again. 😢");
  }
}

// ---------------------------------------------------------------------------
// Callback: ai_keep_original_<logId>  — user rejects the refined version
// ---------------------------------------------------------------------------

export async function handleKeepOriginal(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery("Original kept ✅");

  // Clear session
  ctx.session.pendingRefinedContent = undefined;
  ctx.session.refiningLogId = undefined;

  await ctx.editMessageText("Okay, keeping the original! 📝 Your words, your style 💪").catch(() => {});
}

// ---------------------------------------------------------------------------
// 8.3 — Voice log handler (Pro only)
// Triggered on ctx.message.voice
// ---------------------------------------------------------------------------

export async function handleVoiceLog(ctx: BotContext): Promise<void> {
  const telegramId = BigInt(ctx.from!.id);
  const dbUser = await prisma.user.findUnique({ where: { telegramId } });
  if (!dbUser) return;

  // ── Free voice quota check ───────────────────────────────────────────────
  if (!dbUser.isPro && dbUser.freeVoiceLogs <= 0) {
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

  const processingMsg = await ctx.reply("🎤 Got your voice note! Transcribing… _(hang tight)_", {
    parse_mode: "Markdown",
  });

  let localPath: string | null = null;

  try {
    // 1. Resolve download URL via Telegram API
    const fileInfo = await ctx.api.getFile(voice.file_id);
    const filePath = fileInfo.file_path!;
    const downloadUrl = `https://api.telegram.org/file/bot${process.env.TELEGRAM_BOT_TOKEN}/${filePath}`;

    // 2. Download OGG to /tmp
    localPath = path.join("/tmp", `${voice.file_id}.ogg`);
    const response = await axios.get<ArrayBuffer>(downloadUrl, { responseType: "arraybuffer" });
    fs.writeFileSync(localPath, Buffer.from(response.data));

    // 3. Transcribe with Whisper
    const transcription = await transcribeVoice(localPath);

    // 3b. Decrement free quota for non-Pro users
    if (!dbUser.isPro) {
      await prisma.user.update({ where: { id: dbUser.id }, data: { freeVoiceLogs: { decrement: 1 } } });
      const remaining = dbUser.freeVoiceLogs - 1;
      console.log(`[voice] User ${dbUser.id} used voice log — ${remaining} free use${remaining !== 1 ? "s" : ""} remaining`);
    }

    // 4. Store in session for save/edit callbacks
    ctx.session.pendingVoiceTranscription = transcription;

    const remainingNote =
      !dbUser.isPro && dbUser.freeVoiceLogs > 1
        ? `\n\n_${dbUser.freeVoiceLogs - 1} free voice log${dbUser.freeVoiceLogs - 1 !== 1 ? "s" : ""} remaining — upgrade to Pro for unlimited 🚀_`
        : !dbUser.isPro && dbUser.freeVoiceLogs === 1
        ? `\n\n_This was your last free voice log! Upgrade to Pro for unlimited 🚀_`
        : "";

    // 5. Show result with action buttons
    await ctx.api.editMessageText(
      ctx.chat!.id,
      processingMsg.message_id,
      `🎤 *Here's what I heard:*\n\n${transcription}${remainingNote}`,
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
  if (!transcription) {
    await ctx.reply("Session expired — please send your voice message again.");
    return;
  }

  const telegramId = BigInt(ctx.from!.id);
  const dbUser = await prisma.user.findUnique({ where: { telegramId } });
  if (!dbUser) return;

  try {
    await prisma.log.create({
      data: {
        userId: dbUser.id,
        content: transcription,
        logDate: new Date(),
        isVoice: true,
      },
    });

    ctx.session.pendingVoiceTranscription = undefined;

    await ctx.editMessageText("Log saved! 🎉 Your voice log is in the books 📖", {
      reply_markup: new InlineKeyboard()
        .text("📅 View calendar", "nav_calendar")
        .text("🏠 Menu", "nav_menu"),
    }).catch(() => {});
  } catch (err) {
    console.error("Error saving voice log:", err);
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

  // Reuse the normal log-accumulation session so the Done ✅ button works
  ctx.session.awaitingLog = true;
  ctx.session.pendingLogParts = [transcription];
  ctx.session.pendingVoiceTranscription = undefined;

  await ctx.reply(
    `✏️ Here's your transcription pre-filled. You can send additional messages to add more, then tap *Done ✅* when you're ready.`,
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard().text("Done ✅", "done_log"),
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
