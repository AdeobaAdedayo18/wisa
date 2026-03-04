// src/services/replayCapture.ts
// Session replay capture engine — buffers and flushes events to ReplayEvent table.

import { prisma } from "../lib/prisma";
import type { BotContext } from "../bot/types";
import type { Bot, NextFunction } from "grammy";

// ---------------------------------------------------------------------------
// Core write function — all events flow through here
// ---------------------------------------------------------------------------

const EVENT_BUFFER: Array<{
  telegramId: bigint;
  eventType: string;
  direction: string;
  payload: string;
  timestamp: Date;
}> = [];

let flushTimer: ReturnType<typeof setTimeout> | null = null;
const FLUSH_INTERVAL_MS = 2_000; // flush every 2 seconds
const FLUSH_SIZE = 50; // or when buffer hits 50 events

async function flushBuffer(): Promise<void> {
  if (EVENT_BUFFER.length === 0) return;

  const batch = EVENT_BUFFER.splice(0, EVENT_BUFFER.length);

  try {
    await prisma.replayEvent.createMany({ data: batch });
  } catch (err) {
    console.error("[replay] Failed to flush event buffer:", err);
    // Re-queue failed events (with size guard to prevent memory leak)
    if (EVENT_BUFFER.length < 500) {
      EVENT_BUFFER.unshift(...batch);
    }
  }
}

function scheduleFlush(): void {
  if (flushTimer) return;
  flushTimer = setTimeout(async () => {
    flushTimer = null;
    await flushBuffer();
  }, FLUSH_INTERVAL_MS);
}

/**
 * Queue a replay event for batched insert.
 * Events are buffered and flushed every 2s or when 50 events accumulate.
 */
export function logReplayEvent(
  telegramId: bigint,
  eventType: string,
  direction: "incoming" | "outgoing" | "system",
  payload: Record<string, unknown>,
): void {
  EVENT_BUFFER.push({
    telegramId,
    eventType,
    direction,
    payload: JSON.stringify(payload),
    timestamp: new Date(),
  });

  if (EVENT_BUFFER.length >= FLUSH_SIZE) {
    // Flush immediately (don't await — fire and forget)
    void flushBuffer();
  } else {
    scheduleFlush();
  }
}

/** Force-flush on process shutdown (graceful exit). */
export async function flushReplayBuffer(): Promise<void> {
  if (flushTimer) {
    clearTimeout(flushTimer);
    flushTimer = null;
  }
  await flushBuffer();
}

// ---------------------------------------------------------------------------
// 3.2 — Incoming event middleware
// ---------------------------------------------------------------------------

export function replayMiddleware() {
  return async (ctx: BotContext, next: NextFunction): Promise<void> => {
    const fromId = ctx.from?.id;
    if (!fromId) {
      await next();
      return;
    }

    const telegramId = BigInt(fromId);
    const firstName = ctx.from?.first_name ?? "";
    const username = ctx.from?.username ?? "";
    const chatId = ctx.chat?.id ?? 0;

    // ── Capture incoming text message ──────────────────────────────────
    if (ctx.message?.text) {
      logReplayEvent(telegramId, "user_message", "incoming", {
        messageId: ctx.message.message_id,
        text: ctx.message.text,
        chatId,
        firstName,
        username,
      });
    }

    // ── Capture incoming voice message ─────────────────────────────────
    if (ctx.message?.voice) {
      logReplayEvent(telegramId, "user_voice", "incoming", {
        messageId: ctx.message.message_id,
        duration: ctx.message.voice.duration,
        fileId: ctx.message.voice.file_id,
        chatId,
        firstName,
        username,
      });
    }

    // ── Capture callback query (button press) ──────────────────────────
    if (ctx.callbackQuery?.data) {
      // Try to resolve the button label from the originating message
      let buttonLabel = ctx.callbackQuery.data;
      const msg = ctx.callbackQuery.message;
      if (msg && "reply_markup" in msg && msg.reply_markup?.inline_keyboard) {
        outer: for (const row of msg.reply_markup.inline_keyboard) {
          for (const btn of row) {
            if ("callback_data" in btn && btn.callback_data === ctx.callbackQuery.data) {
              buttonLabel = btn.text;
              break outer;
            }
          }
        }
      }

      logReplayEvent(telegramId, "user_callback", "incoming", {
        callbackQueryId: ctx.callbackQuery.id,
        data: ctx.callbackQuery.data,
        buttonLabel,
        messageId: msg?.message_id ?? null,
        chatId,
        firstName,
        username,
      });
    }

    // ── Snapshot session state BEFORE handler runs ─────────────────────
    // Deep-clone via JSON to avoid capturing a reference
    let sessionBefore: Record<string, unknown> | null = null;
    try {
      sessionBefore = ctx.session ? JSON.parse(JSON.stringify(ctx.session)) : null;
    } catch {
      // session not yet loaded — will be null, no diff
    }

    // Run downstream handlers
    await next();

    // ── Snapshot session state AFTER handler runs ──────────────────────
    if (sessionBefore && ctx.session) {
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      const keys = new Set([
        ...Object.keys(sessionBefore),
        ...Object.keys(ctx.session as unknown as Record<string, unknown>),
      ]);

      for (const key of keys) {
        const before = sessionBefore[key];
        const after = (ctx.session as unknown as Record<string, unknown>)[key];
        // Compare serialized values to handle arrays/objects
        if (JSON.stringify(before) !== JSON.stringify(after)) {
          changes[key] = { from: before, to: after };
        }
      }

      if (Object.keys(changes).length > 0) {
        logReplayEvent(telegramId, "state_change", "system", {
          changes,
          chatId,
        });
      }
    }
  };
}

// ---------------------------------------------------------------------------
// 3.4 — Error capture helper
// ---------------------------------------------------------------------------

/**
 * Log an error as a ReplayEvent. Call this in catch blocks.
 *
 * Usage:
 *   captureReplayError(telegramId, err, "handleAiRefine", ctx.chat?.id);
 */
export function captureReplayError(
  telegramId: bigint | number,
  error: unknown,
  context: string,
  chatId?: number,
): void {
  const err = error instanceof Error ? error : new Error(String(error));

  logReplayEvent(BigInt(telegramId), "error", "system", {
    errorMessage: err.message,
    errorStack: err.stack?.slice(0, 1000) ?? "",
    context,
    chatId: chatId ?? 0,
  });
}

// ---------------------------------------------------------------------------
// 3.5 — Outgoing API call capture via grammY Transformer
// ---------------------------------------------------------------------------

/**
 * grammY Transformer that intercepts ALL outgoing API calls.
 * Catches ctx.reply(), ctx.replyWithPhoto(), bot.api.sendMessage(), etc.
 * Register with: bot.api.config.use(replayTransformer);
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function replayTransformer(prev: any, method: string, payload: any, signal?: AbortSignal): any {
  // Call the original method first — never delay the actual API call
  const result = prev(method, payload, signal);

  // Fire-and-forget logging (don't block the API call)
  (result as Promise<Record<string, unknown>>).then?.((res) => {
    try {
      const chatId = payload?.chat_id;
      if (!chatId) return; // skip methods without chat_id (e.g. getMe, answerCallbackQuery)

      const tid = BigInt(chatId as string | number);

      switch (method) {
        case "sendMessage":
          logReplayEvent(tid, "bot_message", "outgoing", {
            messageId: (res as Record<string, unknown>)?.message_id ?? null,
            text: (payload.text as string) ?? "",
            chatId: Number(chatId),
            parseMode: payload.parse_mode ?? null,
            hasPhoto: false,
            replyMarkup: payload.reply_markup ?? null,
          });
          break;

        case "sendPhoto":
          logReplayEvent(tid, "bot_photo", "outgoing", {
            messageId: (res as Record<string, unknown>)?.message_id ?? null,
            caption: (payload.caption as string) ?? "",
            chatId: Number(chatId),
            parseMode: payload.parse_mode ?? null,
          });
          break;

        case "editMessageText":
          logReplayEvent(tid, "bot_edit", "outgoing", {
            messageId: payload.message_id ?? null,
            newText: (payload.text as string) ?? "",
            chatId: Number(chatId),
            parseMode: payload.parse_mode ?? null,
            replyMarkup: payload.reply_markup ?? null,
          });
          break;

        case "editMessageReplyMarkup":
          logReplayEvent(tid, "bot_edit", "outgoing", {
            messageId: payload.message_id ?? null,
            newText: "(markup only)",
            chatId: Number(chatId),
            replyMarkup: payload.reply_markup ?? null,
          });
          break;
      }
    } catch {
      // Never let replay logging break the actual bot
    }
  });

  return result;
}
