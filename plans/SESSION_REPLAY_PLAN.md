# Wisa Session Replay — Technical Implementation Plan

> **Purpose**: Build a production-ready session replay system for the Wisa Telegram bot that captures every user interaction and reconstructs it as a Telegram-like conversation UI in the admin dashboard. This lets admins see *exactly* what a user experienced — every message, button press, bot response, error, and timing — without needing screen recordings.

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Data Model (Prisma Schema)](#2-data-model-prisma-schema)
3. [Event Capture Layer](#3-event-capture-layer)
4. [API Endpoints](#4-api-endpoints)
5. [Admin Dashboard — Session List UI](#5-admin-dashboard--session-list-ui)
6. [Admin Dashboard — Replay Viewer UI](#6-admin-dashboard--replay-viewer-ui)
7. [Data Retention & Cleanup](#7-data-retention--cleanup)
8. [Error Capture](#8-error-capture)
9. [Performance Considerations](#9-performance-considerations)
10. [File-by-File Implementation Checklist](#10-file-by-file-implementation-checklist)
11. [Testing Plan](#11-testing-plan)
12. [Rollback Strategy](#12-rollback-strategy)

---

## 1. Architecture Overview

### The Core Concept

PostHog replays DOM mutations for web apps. For a Telegram bot, the "DOM" is the **conversation stream**: messages in and out, inline button presses, session state transitions, and errors. Our session replay is a **deterministic conversation reconstruction** — we capture every atomic event with timestamps and metadata, then re-render it as a Telegram-like chat UI.

### High-Level Flow

```
┌─────────────────────────────────────────────────────────────────────────┐
│                           TELEGRAM USER                                  │
│                     sends message / taps button                          │
└─────────────────┬───────────────────────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    grammY MIDDLEWARE (capture layer)                      │
│                                                                          │
│  1. Intercept incoming update → log as ReplayEvent                       │
│  2. Wrap bot.api methods → log outgoing messages as ReplayEvents         │
│  3. Capture errors from downstream handlers → log as error events        │
│  4. Snapshot session state changes → log as state events                 │
│                                                                          │
└─────────────────┬───────────────────────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                     POSTGRESQL (ReplayEvent table)                       │
│                                                                          │
│  Indexed by: telegramId, timestamp                                       │
│  30-day TTL via nightly cron                                             │
│  Grouped into "sessions" by telegramId for list view                     │
│                                                                          │
└─────────────────┬───────────────────────────────────────────────────────┘
                  │
                  ▼
┌─────────────────────────────────────────────────────────────────────────┐
│                    ADMIN DASHBOARD (/admin)                               │
│                                                                          │
│  New sidebar tab: "🔄 Session Replay"                                    │
│                                                                          │
│  ┌──────────────────┐    ┌─────────────────────────────────────────┐     │
│  │  SESSION LIST     │    │  REPLAY VIEWER                          │     │
│  │                   │    │                                         │     │
│  │  User A — 2m ago  │──▶│  Telegram-style chat bubbles             │     │
│  │  User B — 5m ago  │    │  Bot messages (left, grey)              │     │
│  │  User C — 1h ago  │    │  User messages (right, blue)            │     │
│  │  ...              │    │  Button presses (center, pill)           │     │
│  │                   │    │  Errors (center, red banner)             │     │
│  │                   │    │  Date separators between days            │     │
│  │                   │    │  Timestamps on each message              │     │
│  └──────────────────┘    └─────────────────────────────────────────┘     │
│                                                                          │
└─────────────────────────────────────────────────────────────────────────┘
```

### What Gets Captured

| Event Type | Direction | Examples |
|---|---|---|
| `user_message` | Incoming | Text messages, commands (/start) |
| `user_voice` | Incoming | Voice note sent by user |
| `user_callback` | Incoming | Inline button press (callback_data) |
| `bot_message` | Outgoing | Text replies from bot |
| `bot_photo` | Outgoing | Scene images with captions |
| `bot_edit` | Outgoing | Edited messages (e.g., loading → result) |
| `bot_callback_answer` | Outgoing | answerCallbackQuery responses |
| `error` | System | Unhandled errors, API failures, OpenAI errors |
| `state_change` | System | Session state transitions (awaitingLog → true, etc.) |

---

## 2. Data Model (Prisma Schema)

### New Model: `ReplayEvent`

Add to `prisma/schema.prisma`:

```prisma
model ReplayEvent {
  id         Int      @id @default(autoincrement())
  telegramId BigInt
  eventType  String   // "user_message" | "user_voice" | "user_callback" | "bot_message" | "bot_photo" | "bot_edit" | "bot_callback_answer" | "error" | "state_change"
  direction  String   // "incoming" | "outgoing" | "system"
  payload    String   // JSON blob — full event data (see schema below)
  timestamp  DateTime @default(now())

  @@index([telegramId, timestamp(sort: Desc)])
  @@index([timestamp])
}
```

### Why This Schema Works

- **Single table, not normalized**: Each event is a self-contained JSON blob. This keeps writes fast (single INSERT), reads simple (one query per session), and avoids JOIN complexity.
- **`telegramId` as the grouping key**: Every user's events form one continuous "session" — the conversation they have with the bot over time. We don't need a separate Session concept because Telegram bot conversations are inherently continuous.
- **Composite index `(telegramId, timestamp DESC)`**: This is the hot path — fetching a user's events in reverse chronological order for the replay viewer.
- **`timestamp` index**: For the cleanup cron (DELETE WHERE timestamp < 30 days ago) and for the session list (latest event per user).

### Payload Schema (JSON)

The `payload` field stores a JSON string. Structure varies by `eventType`:

#### `user_message`
```json
{
  "messageId": 12345,
  "text": "I worked on the API today",
  "chatId": 67890,
  "firstName": "Dayo",
  "username": "dayoadeoba"
}
```

#### `user_voice`
```json
{
  "messageId": 12346,
  "duration": 15,
  "fileId": "AwACAgIAAxk...",
  "chatId": 67890,
  "firstName": "Dayo"
}
```

#### `user_callback`
```json
{
  "callbackQueryId": "abc123",
  "data": "ai_refine_42",
  "messageId": 12340,
  "chatId": 67890,
  "firstName": "Dayo",
  "buttonLabel": "✨ Refine with AI"
}
```

> **Note on `buttonLabel`**: We resolve the human-readable button label from the `callback_data` by checking the inline keyboard of the message the callback originated from. This is crucial for the replay UI — admins see "✨ Refine with AI" not "ai_refine_42".

#### `bot_message`
```json
{
  "messageId": 12347,
  "text": "Log saved! 📖✨\n\nGreat work...",
  "chatId": 67890,
  "parseMode": "Markdown",
  "hasPhoto": false,
  "replyMarkup": {
    "inline_keyboard": [
      [{"text": "✨ Refine with AI", "callback_data": "ai_refine_42"}],
      [{"text": "📖 View logs", "callback_data": "nav_calendar"}, {"text": "🏠 Menu", "callback_data": "nav_menu"}]
    ]
  }
}
```

#### `bot_photo`
```json
{
  "messageId": 12348,
  "caption": "Log saved! 📖✨\n\nGreat work documenting...",
  "chatId": 67890,
  "sceneKey": "scene8",
  "parseMode": "Markdown"
}
```

#### `bot_edit`
```json
{
  "messageId": 12347,
  "newText": "✨ *Here's the refined version:*\n\n...",
  "chatId": 67890,
  "parseMode": "Markdown",
  "replyMarkup": { "inline_keyboard": [...] }
}
```

#### `bot_callback_answer`
```json
{
  "callbackQueryId": "abc123",
  "text": "Original kept ✅",
  "showAlert": false
}
```

#### `error`
```json
{
  "errorMessage": "AI refinement error: OpenAI API rate limit exceeded",
  "errorStack": "Error: 429 Too Many Requests\n    at refineLog...",
  "context": "handleAiRefine",
  "chatId": 67890
}
```

#### `state_change`
```json
{
  "changes": {
    "awaitingLog": { "from": false, "to": true },
    "pendingLogDate": { "from": null, "to": "2026-03-04" }
  },
  "trigger": "startLogging",
  "chatId": 67890
}
```

### Migration

```bash
npx prisma migrate dev --name add_replay_events
```

This will generate:

```sql
CREATE TABLE "ReplayEvent" (
    "id" SERIAL NOT NULL,
    "telegramId" BIGINT NOT NULL,
    "eventType" TEXT NOT NULL,
    "direction" TEXT NOT NULL,
    "payload" TEXT NOT NULL,
    "timestamp" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ReplayEvent_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "ReplayEvent_telegramId_timestamp_idx" ON "ReplayEvent"("telegramId", "timestamp" DESC);
CREATE INDEX "ReplayEvent_timestamp_idx" ON "ReplayEvent"("timestamp");
```

---

## 3. Event Capture Layer

### 3.1 New File: `src/services/replayCapture.ts`

This is the core capture engine. It provides:

1. **`replayMiddleware`** — grammY middleware that intercepts all incoming updates
2. **`wrapBotApi`** — patches `bot.api` methods to capture outgoing messages
3. **`logReplayEvent`** — single function to write events to the DB
4. **`captureError`** — error logging helper
5. **`captureStateChange`** — session diffing helper

```typescript
// src/services/replayCapture.ts

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
    flushBuffer();
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
    const telegramId = BigInt(ctx.from?.id ?? 0);
    if (!telegramId) return next();

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
        for (const row of msg.reply_markup.inline_keyboard) {
          for (const btn of row) {
            if (btn.callback_data === ctx.callbackQuery.data) {
              buttonLabel = btn.text;
              break;
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
    const sessionBefore = ctx.session ? { ...ctx.session } : null;

    // Run downstream handlers
    await next();

    // ── Snapshot session state AFTER handler runs ──────────────────────
    if (sessionBefore && ctx.session) {
      const changes: Record<string, { from: unknown; to: unknown }> = {};
      const keys = new Set([
        ...Object.keys(sessionBefore),
        ...Object.keys(ctx.session),
      ]);

      for (const key of keys) {
        const before = (sessionBefore as Record<string, unknown>)[key];
        const after = (ctx.session as Record<string, unknown>)[key];
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
// 3.3 — Outgoing message capture (bot.api wrapper)
// ---------------------------------------------------------------------------

/**
 * Monkey-patches bot.api to intercept outgoing calls.
 * Call once during bot setup, AFTER bot is created but BEFORE bot.start().
 *
 * This wraps:
 *   - sendMessage
 *   - sendPhoto
 *   - editMessageText
 *   - answerCallbackQuery
 *
 * Each wrapper logs the outgoing event, then calls the original method.
 */
export function wrapBotApiForReplay(bot: Bot<BotContext>): void {
  const originalSendMessage = bot.api.sendMessage.bind(bot.api);
  const originalSendPhoto = bot.api.sendPhoto.bind(bot.api);
  const originalEditMessageText = bot.api.editMessageText.bind(bot.api);
  const originalAnswerCallbackQuery = bot.api.answerCallbackQuery.bind(bot.api);

  // ── sendMessage ──────────────────────────────────────────────────────
  bot.api.sendMessage = async (chatId: number | string, text: string, other?: any) => {
    const result = await originalSendMessage(chatId, text, other);

    // Resolve telegramId from chatId (for DMs, chatId === telegramId)
    const tid = BigInt(chatId);
    logReplayEvent(tid, "bot_message", "outgoing", {
      messageId: result.message_id,
      text,
      chatId: Number(chatId),
      parseMode: other?.parse_mode ?? null,
      hasPhoto: false,
      replyMarkup: other?.reply_markup ?? null,
    });

    return result;
  };

  // ── sendPhoto ────────────────────────────────────────────────────────
  bot.api.sendPhoto = async (chatId: number | string, photo: any, other?: any) => {
    const result = await originalSendPhoto(chatId, photo, other);

    const tid = BigInt(chatId);
    logReplayEvent(tid, "bot_photo", "outgoing", {
      messageId: result.message_id,
      caption: other?.caption ?? "",
      chatId: Number(chatId),
      parseMode: other?.parse_mode ?? null,
    });

    return result;
  };

  // ── editMessageText ──────────────────────────────────────────────────
  // editMessageText can be called with (chatId, messageId, text) or
  // via ctx.editMessageText which calls a different overload.
  // We wrap the 3-arg version used in the codebase (bot.api.editMessageText).
  const origEdit = bot.api.raw.editMessageText.bind(bot.api.raw);
  bot.api.raw.editMessageText = async (args: any) => {
    const result = await origEdit(args);

    if (args.chat_id) {
      const tid = BigInt(args.chat_id);
      logReplayEvent(tid, "bot_edit", "outgoing", {
        messageId: args.message_id ?? null,
        newText: args.text ?? "",
        chatId: Number(args.chat_id),
        parseMode: args.parse_mode ?? null,
        replyMarkup: args.reply_markup ?? null,
      });
    }

    return result;
  };

  // ── answerCallbackQuery ──────────────────────────────────────────────
  bot.api.answerCallbackQuery = async (callbackQueryId: string, other?: any) => {
    const result = await originalAnswerCallbackQuery(callbackQueryId, other);

    // We don't have telegramId from the callbackQueryId alone.
    // This is handled by correlating with the preceding user_callback event.
    // We still log it for completeness — see note below.

    return result;
  };
}

// ---------------------------------------------------------------------------
// 3.4 — Error capture helper
// ---------------------------------------------------------------------------

/**
 * Log an error as a ReplayEvent. Call this in catch blocks.
 *
 * Usage:
 *   captureReplayError(telegramId, err, "handleAiRefine", chatId);
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
// 3.5 — ctx.reply / ctx.replyWithPhoto capture via Transformer
// ---------------------------------------------------------------------------

/**
 * Alternative / complementary approach using grammY's Transformer API.
 * This catches ALL outgoing API calls including ctx.reply(), ctx.replyWithPhoto(), etc.
 * Register with: bot.api.config.use(replayTransformer);
 *
 * This is more robust than wrapping individual methods because it catches
 * every API call regardless of how it's invoked (ctx.reply, bot.api.sendMessage, etc.)
 */
export function replayTransformer(prev: any, method: string, payload: any, signal?: AbortSignal) {
  // Call the original method first
  const result = prev(method, payload, signal);

  // Fire-and-forget logging (don't block the API call)
  result.then?.((res: any) => {
    try {
      const chatId = payload?.chat_id;
      if (!chatId) return; // skip methods without chat_id (e.g. getMe)

      const tid = BigInt(chatId);

      switch (method) {
        case "sendMessage":
          logReplayEvent(tid, "bot_message", "outgoing", {
            messageId: res?.message_id ?? null,
            text: payload.text ?? "",
            chatId: Number(chatId),
            parseMode: payload.parse_mode ?? null,
            hasPhoto: false,
            replyMarkup: payload.reply_markup ?? null,
          });
          break;

        case "sendPhoto":
          logReplayEvent(tid, "bot_photo", "outgoing", {
            messageId: res?.message_id ?? null,
            caption: payload.caption ?? "",
            chatId: Number(chatId),
            parseMode: payload.parse_mode ?? null,
          });
          break;

        case "editMessageText":
          logReplayEvent(tid, "bot_edit", "outgoing", {
            messageId: payload.message_id ?? null,
            newText: payload.text ?? "",
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
```

### 3.6 — Integration Point: `src/bot/index.ts`

Register the middleware and transformer in the bot setup. The replay middleware must go **before** the session middleware so it can capture the raw incoming update, but the session diff logic runs **after** `next()`:

```typescript
// src/bot/index.ts — add these imports
import { replayMiddleware, replayTransformer, flushReplayBuffer } from "../services/replayCapture";

export const bot = new Bot<BotContext>(process.env.TELEGRAM_BOT_TOKEN!);

// ── Replay capture (MUST be before session middleware) ───────────────────
bot.use(replayMiddleware());

// ── Outgoing API call capture via Transformer ────────────────────────────
bot.api.config.use(replayTransformer);

// Session middleware (existing — no changes)
bot.use(session({
  initial: (): SessionData => ({ awaitingLog: false, pendingLogParts: [] }),
  storage: new PrismaAdapter<SessionData>(prisma.session),
}));

// ... rest of existing code ...
```

### Important: Middleware ordering note

The `replayMiddleware` must wrap the session middleware so the session snapshot diff works:

```
Incoming update
  → replayMiddleware (captures incoming event)
    → session middleware (loads session)
      → conversations, handlers, etc.
    → session middleware (saves session)
  → replayMiddleware (diffs session, logs state_change)
```

Since grammY middleware runs in an onion model (`before next()` → downstream → `after next()`), placing `replayMiddleware()` first achieves this naturally.

### 3.7 — Graceful Shutdown

In `src/index.ts`, add buffer flush before exit:

```typescript
import { flushReplayBuffer } from "./services/replayCapture";

// In the main() function, add shutdown handler:
process.on("SIGTERM", async () => {
  console.log("[shutdown] Flushing replay buffer...");
  await flushReplayBuffer();
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("[shutdown] Flushing replay buffer...");
  await flushReplayBuffer();
  process.exit(0);
});
```

### 3.8 — Error Capture Integration

Add `captureReplayError` calls to existing catch blocks. Example changes:

**`src/bot/aiFeatures.ts` — handleAiRefine:**
```typescript
  } catch (err) {
    console.error("AI refinement error:", err);
    captureReplayError(telegramId, err, "handleAiRefine", ctx.chat?.id);
    await ctx.api.editMessageText(/* ... */);
  }
```

**`src/bot/aiFeatures.ts` — handleVoiceLog:**
```typescript
  } catch (err) {
    console.error("Voice transcription error:", err);
    captureReplayError(telegramId, err, "handleVoiceLog", ctx.chat?.id);
    await ctx.api.editMessageText(/* ... */);
  }
```

**`src/index.ts` — webhook handler:**
```typescript
  } catch (err) {
    console.error("[webhook] Error processing charge.success:", err);
    captureReplayError(telegramId, err, "webhook:charge.success");
  }
```

**`src/services/scheduler.ts` — reminder handler:**
```typescript
  } catch (e) {
    console.error(`[scheduler] Failed to send reminder for job ${job.id}:`, e);
    captureReplayError(job.telegramId, e, "scheduler:sendReminder");
  }
```

**Global grammY error handler** — add to `src/bot/index.ts`:
```typescript
bot.catch((err) => {
  const ctx = err.ctx;
  const telegramId = ctx.from?.id ?? 0;
  console.error(`[bot] Error for user ${telegramId}:`, err.error);

  captureReplayError(
    BigInt(telegramId),
    err.error,
    `bot.catch:${err.message}`,
    ctx.chat?.id,
  );
});
```

This ensures **every error** — whether from a specific handler, the scheduler, webhooks, or unhandled middleware failures — gets logged as a replay event tied to the user's session.

---

## 4. API Endpoints

### New file: Add routes to `src/admin/router.ts`

All endpoints are behind the existing `basicAuth` middleware.

### 4.1 — `GET /admin/api/replay/sessions`

Returns the session list — one entry per user, sorted by most recent activity.

```typescript
// ─── /api/replay/sessions — list all user sessions ────────────────────────
router.get(
  "/api/replay/sessions",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10));
      const limit = Math.min(50, Math.max(1, parseInt(String(req.query.limit ?? "25"), 10)));
      const search = String(req.query.search ?? "").trim();
      const offset = (page - 1) * limit;

      // Step 1: Get latest event per user (subquery-style via raw SQL for performance)
      // This is the most efficient way to get "latest event per telegramId"
      const sessionsRaw: Array<{
        telegramId: bigint;
        latestTimestamp: Date;
        eventCount: bigint;
        errorCount: bigint;
      }> = await prisma.$queryRaw`
        SELECT
          "telegramId",
          MAX("timestamp") AS "latestTimestamp",
          COUNT(*)::bigint AS "eventCount",
          COUNT(*) FILTER (WHERE "eventType" = 'error')::bigint AS "errorCount"
        FROM "ReplayEvent"
        GROUP BY "telegramId"
        ORDER BY MAX("timestamp") DESC
        LIMIT ${limit} OFFSET ${offset}
      `;

      // Step 2: Enrich with user info
      const telegramIds = sessionsRaw.map((s) => s.telegramId);
      const users = await prisma.user.findMany({
        where: { telegramId: { in: telegramIds } },
        select: {
          telegramId: true,
          firstName: true,
          username: true,
          isPro: true,
        },
      });
      const userMap = new Map(users.map((u) => [u.telegramId.toString(), u]));

      // Step 3: Get the latest message preview for each user
      const previews = await Promise.all(
        telegramIds.map(async (tid) => {
          const latest = await prisma.replayEvent.findFirst({
            where: { telegramId: tid },
            orderBy: { timestamp: "desc" },
            select: { eventType: true, payload: true },
          });
          if (!latest) return { tid: tid.toString(), preview: "" };

          try {
            const p = JSON.parse(latest.payload);
            let preview = "";
            switch (latest.eventType) {
              case "user_message":
                preview = p.text?.slice(0, 80) ?? "";
                break;
              case "bot_message":
                preview = p.text?.slice(0, 80) ?? "";
                break;
              case "user_callback":
                preview = `Tapped: ${p.buttonLabel ?? p.data}`;
                break;
              case "error":
                preview = `⚠️ ${p.errorMessage?.slice(0, 60)}`;
                break;
              default:
                preview = latest.eventType;
            }
            return { tid: tid.toString(), preview };
          } catch {
            return { tid: tid.toString(), preview: latest.eventType };
          }
        }),
      );
      const previewMap = new Map(previews.map((p) => [p.tid, p.preview]));

      // Step 4: Get total count for pagination
      const totalRaw: Array<{ count: bigint }> = await prisma.$queryRaw`
        SELECT COUNT(DISTINCT "telegramId")::bigint AS count FROM "ReplayEvent"
      `;
      const total = Number(totalRaw[0]?.count ?? 0);

      // Step 5: Build response
      const data = sessionsRaw.map((s) => {
        const user = userMap.get(s.telegramId.toString());
        return {
          telegramId: s.telegramId.toString(),
          firstName: user?.firstName ?? "Unknown",
          username: user?.username ?? null,
          isPro: user?.isPro ?? false,
          lastActivity: s.latestTimestamp,
          eventCount: Number(s.eventCount),
          errorCount: Number(s.errorCount),
          preview: previewMap.get(s.telegramId.toString()) ?? "",
        };
      });

      // Optional: filter by search term (post-query — fine for <10k users)
      const filtered = search
        ? data.filter(
            (d) =>
              d.firstName.toLowerCase().includes(search.toLowerCase()) ||
              (d.username?.toLowerCase().includes(search.toLowerCase()) ?? false) ||
              d.telegramId.includes(search),
          )
        : data;

      res.json({
        data: filtered,
        total,
        page,
        pages: Math.ceil(total / limit),
      });
    } catch (err) {
      handleError(res, "/api/replay/sessions", err);
    }
  },
);
```

### 4.2 — `GET /admin/api/replay/events/:telegramId`

Returns all events for a specific user, paginated and ordered chronologically (oldest first for the replay, but the API supports both directions).

```typescript
// ─── /api/replay/events/:telegramId — get events for replay ──────────────
router.get(
  "/api/replay/events/:telegramId",
  async (req: Request, res: Response): Promise<void> => {
    try {
      const telegramId = BigInt(req.params.telegramId);
      const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10));
      const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? "100"), 10)));
      const skip = (page - 1) * limit;
      const order = req.query.order === "desc" ? "desc" : "asc";

      // Optional date range filter
      const afterStr = String(req.query.after ?? "");
      const beforeStr = String(req.query.before ?? "");
      const where: Record<string, unknown> = { telegramId };

      if (afterStr || beforeStr) {
        const timestampFilter: Record<string, Date> = {};
        if (afterStr) timestampFilter.gte = new Date(afterStr);
        if (beforeStr) timestampFilter.lte = new Date(beforeStr);
        where.timestamp = timestampFilter;
      }

      // Optional event type filter
      const eventType = String(req.query.eventType ?? "");
      if (eventType) {
        where.eventType = eventType;
      }

      const [events, total] = await Promise.all([
        prisma.replayEvent.findMany({
          where,
          skip,
          take: limit,
          orderBy: { timestamp: order as "asc" | "desc" },
        }),
        prisma.replayEvent.count({ where }),
      ]);

      // Get user info
      const user = await prisma.user.findUnique({
        where: { telegramId },
        select: {
          firstName: true,
          username: true,
          isPro: true,
          createdAt: true,
          logFrequency: true,
          timezone: true,
        },
      });

      res.json({
        user: user
          ? { ...user, telegramId: telegramId.toString() }
          : { telegramId: telegramId.toString() },
        data: events.map((e) => ({
          id: e.id,
          eventType: e.eventType,
          direction: e.direction,
          payload: JSON.parse(e.payload),
          timestamp: e.timestamp,
        })),
        total,
        page,
        pages: Math.ceil(total / limit),
      });
    } catch (err) {
      handleError(res, "/api/replay/events/:telegramId", err);
    }
  },
);
```

### 4.3 — `GET /admin/api/replay/stats`

Quick stats for the replay dashboard header.

```typescript
// ─── /api/replay/stats — replay system stats ─────────────────────────────
router.get(
  "/api/replay/stats",
  async (_req: Request, res: Response): Promise<void> => {
    try {
      const now = new Date();
      const todayStart = startOfDay(now);

      const [totalEvents, totalSessions, eventsToday, errorsToday] = await Promise.all([
        prisma.replayEvent.count(),
        prisma.$queryRaw<Array<{ count: bigint }>>`
          SELECT COUNT(DISTINCT "telegramId")::bigint AS count FROM "ReplayEvent"
        `.then((r) => Number(r[0]?.count ?? 0)),
        prisma.replayEvent.count({
          where: { timestamp: { gte: todayStart } },
        }),
        prisma.replayEvent.count({
          where: { eventType: "error", timestamp: { gte: todayStart } },
        }),
      ]);

      res.json({
        totalEvents,
        totalSessions,
        eventsToday,
        errorsToday,
      });
    } catch (err) {
      handleError(res, "/api/replay/stats", err);
    }
  },
);
```

---

## 5. Admin Dashboard — Session List UI

### 5.1 — Sidebar Addition

Add a new nav item in the sidebar (in `dashboard.html`):

```html
<!-- In the sidebar nav section, after existing nav items -->
<div class="nav-item" data-panel="replay" onclick="switchPanel('replay')">
  <span class="nav-icon">🔄</span> Session Replay
  <span class="nav-badge hidden" id="replay-error-badge">0</span>
</div>
```

### 5.2 — Session List Panel

The session list shows one card per user, sorted by most recent activity. Each card shows:
- User avatar (first letter) + name + username
- Pro badge if applicable
- Last activity timestamp (relative: "2m ago", "1h ago")
- Event count + error count
- Latest message preview (truncated)

```html
<!-- New panel in #content -->
<div class="panel" id="panel-replay">
  <!-- Stats row -->
  <div class="stats-grid" id="replay-stats-grid">
    <div class="stat-card card-purple">
      <div class="card-label">TRACKED SESSIONS</div>
      <div class="card-value" id="rstat-sessions">—</div>
      <div class="card-icon">🔄</div>
    </div>
    <div class="stat-card card-green">
      <div class="card-label">EVENTS TODAY</div>
      <div class="card-value" id="rstat-events-today">—</div>
      <div class="card-icon">📊</div>
    </div>
    <div class="stat-card card-red">
      <div class="card-label">ERRORS TODAY</div>
      <div class="card-value" id="rstat-errors-today">—</div>
      <div class="card-icon">⚠️</div>
    </div>
    <div class="stat-card card-yellow">
      <div class="card-label">TOTAL EVENTS</div>
      <div class="card-value" id="rstat-total-events">—</div>
      <div class="card-icon">💾</div>
    </div>
  </div>

  <!-- Search + Filters -->
  <div class="table-card">
    <div class="table-header">
      <h3>🔄 Session Replays</h3>
      <input
        type="text"
        class="search-input"
        id="replay-search"
        placeholder="Search by name, username, or Telegram ID..."
        oninput="debounceReplaySearch()"
      />
    </div>

    <!-- Session list -->
    <div class="section-body" id="replay-session-list" style="max-height: 600px;">
      <div class="empty-state">
        <div class="empty-icon">🔄</div>
        Loading sessions...
      </div>
    </div>

    <!-- Pagination -->
    <div style="padding: 12px 20px; border-top: 1px solid var(--border); display: flex; align-items: center; justify-content: space-between;">
      <span class="user-meta" id="replay-page-info">Page 1 of 1</span>
      <div style="display: flex; gap: 8px;">
        <button class="btn-refresh" id="replay-prev-btn" onclick="replayPrevPage()" disabled>◀ Prev</button>
        <button class="btn-refresh" id="replay-next-btn" onclick="replayNextPage()">Next ▶</button>
      </div>
    </div>
  </div>
</div>
```

### 5.3 — Session List Row Template

Each session in the list renders as:

```html
<div class="user-row replay-session-row" onclick="openReplay('${telegramId}')" style="cursor: pointer;">
  <div class="user-avatar">${firstLetter}</div>
  <div style="flex: 1; min-width: 0;">
    <div class="user-name">
      ${firstName}
      ${username ? `<span style="color: var(--t3); font-weight: 400;">@${username}</span>` : ''}
      ${isPro ? '<span class="pro-badge">PRO</span>' : ''}
      ${errorCount > 0 ? `<span style="background: var(--red-g); color: var(--red); font-size: 10px; font-weight: 700; padding: 2px 6px; border-radius: 99px; margin-left: 4px;">⚠ ${errorCount}</span>` : ''}
    </div>
    <div class="user-meta" style="white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 400px;">
      ${preview}
    </div>
  </div>
  <div style="text-align: right; flex-shrink: 0;">
    <div class="time-badge">${relativeTime}</div>
    <div class="user-meta">${eventCount} events</div>
  </div>
</div>
```

### 5.4 — Session List JavaScript

```javascript
// ── Session Replay State ───────────────────────────────────────────────
let replayPage = 1;
let replaySearch = '';
let replayDebounceTimer = null;

function debounceReplaySearch() {
  clearTimeout(replayDebounceTimer);
  replayDebounceTimer = setTimeout(() => {
    replaySearch = document.getElementById('replay-search').value;
    replayPage = 1;
    loadReplaySessions();
  }, 300);
}

async function loadReplaySessions() {
  try {
    const [sessionsRes, statsRes] = await Promise.all([
      fetch(`/admin/api/replay/sessions?page=${replayPage}&limit=25&search=${encodeURIComponent(replaySearch)}`),
      fetch('/admin/api/replay/stats'),
    ]);

    const sessions = await sessionsRes.json();
    const stats = await statsRes.json();

    // Update stats
    document.getElementById('rstat-sessions').textContent = stats.totalSessions.toLocaleString();
    document.getElementById('rstat-events-today').textContent = stats.eventsToday.toLocaleString();
    document.getElementById('rstat-errors-today').textContent = stats.errorsToday.toLocaleString();
    document.getElementById('rstat-total-events').textContent = stats.totalEvents.toLocaleString();

    // Update error badge in sidebar
    const badge = document.getElementById('replay-error-badge');
    if (stats.errorsToday > 0) {
      badge.textContent = stats.errorsToday;
      badge.classList.remove('hidden');
    } else {
      badge.classList.add('hidden');
    }

    // Render session list
    const list = document.getElementById('replay-session-list');

    if (!sessions.data?.length) {
      list.innerHTML = `
        <div class="empty-state">
          <div class="empty-icon">🔍</div>
          ${replaySearch ? 'No sessions match your search.' : 'No sessions recorded yet. Interact with the bot to start capturing.'}
        </div>`;
      return;
    }

    list.innerHTML = sessions.data.map(s => {
      const letter = (s.firstName || '?')[0].toUpperCase();
      const ago = timeAgo(new Date(s.lastActivity));
      const errBadge = s.errorCount > 0
        ? `<span style="background:var(--red-g);color:var(--red);font-size:10px;font-weight:700;padding:2px 6px;border-radius:99px;margin-left:4px;">⚠ ${s.errorCount}</span>`
        : '';
      const proBadge = s.isPro ? '<span class="pro-badge">PRO</span>' : '';
      const usernameSpan = s.username
        ? `<span style="color:var(--t3);font-weight:400;margin-left:4px;">@${s.username}</span>`
        : '';

      return `
        <div class="user-row" onclick="openReplay('${s.telegramId}')" style="cursor:pointer;transition:background .12s;">
          <div class="user-avatar">${letter}</div>
          <div style="flex:1;min-width:0;">
            <div class="user-name">${escHtml(s.firstName)}${usernameSpan}${proBadge}${errBadge}</div>
            <div class="user-meta" style="white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:420px;">${escHtml(s.preview)}</div>
          </div>
          <div style="text-align:right;flex-shrink:0;">
            <div class="time-badge">${ago}</div>
            <div class="user-meta">${s.eventCount.toLocaleString()} events</div>
          </div>
        </div>`;
    }).join('');

    // Pagination
    document.getElementById('replay-page-info').textContent = `Page ${sessions.page} of ${sessions.pages}`;
    document.getElementById('replay-prev-btn').disabled = sessions.page <= 1;
    document.getElementById('replay-next-btn').disabled = sessions.page >= sessions.pages;

  } catch (err) {
    console.error('Failed to load replay sessions:', err);
  }
}

function replayPrevPage() { replayPage--; loadReplaySessions(); }
function replayNextPage() { replayPage++; loadReplaySessions(); }

// Utility: relative time
function timeAgo(date) {
  const seconds = Math.floor((Date.now() - date.getTime()) / 1000);
  if (seconds < 60) return 'just now';
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

// Utility: escape HTML
function escHtml(str) {
  const d = document.createElement('div');
  d.textContent = str ?? '';
  return d.innerHTML;
}
```

---

## 6. Admin Dashboard — Replay Viewer UI (The Star of the Show)

This is the Telegram-like conversation viewer. When an admin clicks a session from the list, it opens a full conversation view that looks and feels like opening a Telegram chat.

### 6.1 — Layout Structure

The replay viewer replaces the session list content (or slides in as an overlay). It has:

1. **Chat header** — user info, back button, filter controls
2. **Chat body** — scrollable message area with Telegram-style bubbles
3. **Date separators** — "March 3, 2026" dividers between days (like Telegram)
4. **Message types** rendered differently:
   - **User messages** → right-aligned blue bubbles
   - **Bot messages** → left-aligned grey bubbles
   - **Button presses** → centered pill badges
   - **Errors** → centered red alert banners
   - **State changes** → subtle centered system messages
   - **Photos/scenes** → left-aligned with image placeholder + caption
   - **Voice messages** → right-aligned with mic icon + duration
   - **Edited messages** → left-aligned with "(edited)" indicator

### 6.2 — CSS for the Replay Viewer

```css
/* ── Replay Viewer ─────────────────────────────────────────────────────── */
#replay-viewer {
  display: none;
  flex-direction: column;
  height: 100%;
  background: var(--bg);
  position: absolute;
  inset: 0;
  z-index: 100;
}

#replay-viewer.open {
  display: flex;
}

/* Chat header */
.replay-header {
  display: flex;
  align-items: center;
  gap: 12px;
  padding: 14px 20px;
  background: var(--s1);
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.replay-header .back-btn {
  background: none;
  border: none;
  color: var(--t2);
  font-size: 18px;
  cursor: pointer;
  padding: 4px 8px;
  border-radius: 6px;
  transition: background .15s;
}
.replay-header .back-btn:hover { background: var(--s2); }

.replay-header .chat-info {
  flex: 1;
}
.replay-header .chat-name {
  font-size: 15px;
  font-weight: 600;
  color: var(--t1);
}
.replay-header .chat-meta {
  font-size: 12px;
  color: var(--t3);
}

.replay-header .replay-filters {
  display: flex;
  gap: 6px;
  align-items: center;
}
.replay-filter-btn {
  padding: 5px 10px;
  background: var(--s2);
  border: 1px solid var(--border);
  border-radius: 6px;
  color: var(--t2);
  font-size: 11.5px;
  font-weight: 500;
  cursor: pointer;
  font-family: inherit;
  transition: background .15s, color .15s;
}
.replay-filter-btn:hover { background: var(--s3); color: var(--t1); }
.replay-filter-btn.active { background: var(--accent-g); color: var(--accent); border-color: var(--accent); }

/* Chat body — the scrollable message area */
.replay-chat {
  flex: 1;
  overflow-y: auto;
  padding: 16px 20px;
  display: flex;
  flex-direction: column;
  gap: 4px;

  /* Telegram-style chat background */
  background:
    radial-gradient(ellipse at 20% 50%, rgba(124,58,237,0.04), transparent 70%),
    radial-gradient(ellipse at 80% 20%, rgba(6,182,212,0.03), transparent 70%),
    var(--bg);
}

/* Date separator */
.replay-date-sep {
  text-align: center;
  padding: 12px 0 8px;
}
.replay-date-sep span {
  background: var(--s2);
  border: 1px solid var(--border);
  padding: 4px 14px;
  border-radius: 99px;
  font-size: 12px;
  font-weight: 600;
  color: var(--t2);
  letter-spacing: 0.3px;
}

/* Message bubble base */
.replay-msg {
  max-width: 75%;
  padding: 9px 14px;
  border-radius: 16px;
  font-size: 13.5px;
  line-height: 1.55;
  position: relative;
  word-wrap: break-word;
  overflow-wrap: break-word;
}

.replay-msg .msg-time {
  font-size: 10.5px;
  color: rgba(255,255,255,0.35);
  margin-top: 3px;
  text-align: right;
}

/* User messages (right side — blue) */
.replay-msg.user {
  align-self: flex-end;
  background: #1d4ed8;
  color: #e0e7ff;
  border-bottom-right-radius: 4px;
}
.replay-msg.user .msg-time { color: rgba(224,231,255,0.5); }

/* Bot messages (left side — dark grey) */
.replay-msg.bot {
  align-self: flex-start;
  background: var(--s2);
  color: var(--t1);
  border: 1px solid var(--border);
  border-bottom-left-radius: 4px;
}

/* Bot photo messages */
.replay-msg.bot-photo {
  align-self: flex-start;
  background: var(--s2);
  border: 1px solid var(--border);
  border-radius: 16px;
  border-bottom-left-radius: 4px;
  overflow: hidden;
  padding: 0;
  max-width: 320px;
}
.replay-msg.bot-photo .photo-placeholder {
  width: 100%;
  height: 140px;
  background: linear-gradient(135deg, var(--s3), var(--s2));
  display: flex;
  align-items: center;
  justify-content: center;
  font-size: 32px;
}
.replay-msg.bot-photo .photo-caption {
  padding: 10px 14px;
  font-size: 13px;
  line-height: 1.5;
  color: var(--t1);
}
.replay-msg.bot-photo .msg-time {
  padding: 0 14px 8px;
  font-size: 10.5px;
  color: var(--t3);
  text-align: right;
}

/* Voice messages (user side) */
.replay-msg.voice {
  align-self: flex-end;
  background: #1d4ed8;
  color: #e0e7ff;
  border-bottom-right-radius: 4px;
  display: flex;
  align-items: center;
  gap: 10px;
}
.replay-msg.voice .voice-icon { font-size: 20px; }
.replay-msg.voice .voice-bar {
  flex: 1;
  height: 3px;
  background: rgba(255,255,255,0.2);
  border-radius: 2px;
  position: relative;
}
.replay-msg.voice .voice-dur {
  font-size: 12px;
  color: rgba(224,231,255,0.6);
  white-space: nowrap;
}

/* Button press (centered pill) */
.replay-action {
  align-self: center;
  display: inline-flex;
  align-items: center;
  gap: 6px;
  background: var(--accent-g);
  border: 1px solid rgba(124,58,237,0.25);
  padding: 5px 16px;
  border-radius: 99px;
  font-size: 12px;
  font-weight: 600;
  color: var(--accent);
  margin: 4px 0;
}
.replay-action .action-icon { font-size: 13px; }

/* Error banner (centered) */
.replay-error {
  align-self: center;
  background: var(--red-g);
  border: 1px solid rgba(239,68,68,0.25);
  padding: 10px 18px;
  border-radius: 10px;
  font-size: 12.5px;
  color: var(--red);
  margin: 6px 0;
  max-width: 85%;
}
.replay-error .error-title {
  font-weight: 700;
  margin-bottom: 3px;
  display: flex;
  align-items: center;
  gap: 6px;
}
.replay-error .error-context {
  font-size: 11px;
  color: rgba(239,68,68,0.7);
  font-family: 'Courier New', monospace;
}
.replay-error .error-stack {
  font-size: 10.5px;
  color: rgba(239,68,68,0.5);
  font-family: 'Courier New', monospace;
  margin-top: 4px;
  white-space: pre-wrap;
  max-height: 60px;
  overflow: hidden;
  cursor: pointer;
  transition: max-height .3s;
}
.replay-error .error-stack.expanded {
  max-height: 300px;
}

/* State change (system message) */
.replay-state {
  align-self: center;
  font-size: 11px;
  color: var(--t3);
  background: var(--s2);
  border: 1px solid var(--border);
  padding: 4px 12px;
  border-radius: 99px;
  margin: 2px 0;
  max-width: 85%;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
}
.replay-state:hover {
  background: var(--s3);
  white-space: normal;
  max-width: 85%;
}

/* Edited message indicator */
.edited-badge {
  font-size: 10px;
  color: var(--t3);
  font-style: italic;
  margin-left: 6px;
}

/* Bot message inline keyboard preview */
.msg-keyboard {
  margin-top: 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.msg-keyboard-row {
  display: flex;
  gap: 4px;
}
.msg-kb-btn {
  flex: 1;
  padding: 6px 8px;
  background: rgba(255,255,255,0.06);
  border: 1px solid rgba(255,255,255,0.1);
  border-radius: 8px;
  font-size: 12px;
  color: var(--cyan);
  text-align: center;
  cursor: default;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

/* Loading state */
.replay-loading {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 12px;
  color: var(--t3);
}
.replay-loading .spinner {
  width: 28px;
  height: 28px;
  border: 3px solid var(--border);
  border-top-color: var(--accent);
  border-radius: 50%;
  animation: spin .7s linear infinite;
}

/* Scroll-to-bottom button */
.scroll-bottom-btn {
  position: absolute;
  bottom: 16px;
  right: 24px;
  width: 36px;
  height: 36px;
  background: var(--s2);
  border: 1px solid var(--border);
  border-radius: 50%;
  display: flex;
  align-items: center;
  justify-content: center;
  cursor: pointer;
  font-size: 14px;
  color: var(--t2);
  box-shadow: 0 2px 8px rgba(0,0,0,0.3);
  transition: background .15s;
  z-index: 10;
}
.scroll-bottom-btn:hover { background: var(--s3); }
.scroll-bottom-btn.hidden { display: none; }
```

### 6.3 — Replay Viewer HTML

```html
<!-- Replay viewer (overlay) — placed inside #content area -->
<div id="replay-viewer">
  <!-- Header -->
  <div class="replay-header">
    <button class="back-btn" onclick="closeReplay()">← </button>
    <div class="user-avatar" id="rv-avatar">?</div>
    <div class="chat-info">
      <div class="chat-name" id="rv-name">Loading...</div>
      <div class="chat-meta" id="rv-meta"></div>
    </div>
    <div class="replay-filters">
      <button class="replay-filter-btn active" data-filter="all" onclick="setReplayFilter('all', this)">All</button>
      <button class="replay-filter-btn" data-filter="messages" onclick="setReplayFilter('messages', this)">Messages</button>
      <button class="replay-filter-btn" data-filter="errors" onclick="setReplayFilter('errors', this)">Errors</button>
      <button class="replay-filter-btn" data-filter="state" onclick="setReplayFilter('state', this)">State</button>
    </div>
  </div>

  <!-- Chat body -->
  <div class="replay-chat" id="rv-chat" style="position: relative;">
    <div class="replay-loading" id="rv-loading">
      <div class="spinner"></div>
      Loading conversation...
    </div>
  </div>

  <!-- Scroll-to-bottom -->
  <div class="scroll-bottom-btn hidden" id="rv-scroll-btn" onclick="rvScrollToBottom()">↓</div>

  <!-- Load more / pagination footer -->
  <div style="padding: 8px 20px; background: var(--s1); border-top: 1px solid var(--border); display: flex; justify-content: space-between; align-items: center; flex-shrink: 0;" id="rv-footer">
    <button class="btn-refresh" id="rv-load-older" onclick="rvLoadOlder()">Load older ↑</button>
    <span class="user-meta" id="rv-event-count"></span>
    <button class="btn-refresh" id="rv-load-newer" onclick="rvLoadNewer()">Load newer ↓</button>
  </div>
</div>
```

### 6.4 — Replay Viewer JavaScript

This is the rendering engine — the "playback" system that turns raw events into a Telegram-like conversation:

```javascript
// ── Replay Viewer State ────────────────────────────────────────────────
let rvTelegramId = null;
let rvEvents = [];
let rvPage = 1;
let rvTotalPages = 1;
let rvFilter = 'all';
let rvUser = null;

async function openReplay(telegramId) {
  rvTelegramId = telegramId;
  rvPage = 1;
  rvFilter = 'all';
  rvEvents = [];

  document.getElementById('replay-viewer').classList.add('open');
  document.getElementById('rv-loading').style.display = 'flex';
  document.getElementById('rv-chat').innerHTML = '';
  document.getElementById('rv-chat').appendChild(document.getElementById('rv-loading'));

  await rvLoadEvents();
}

function closeReplay() {
  document.getElementById('replay-viewer').classList.remove('open');
  rvTelegramId = null;
  rvEvents = [];
}

async function rvLoadEvents() {
  if (!rvTelegramId) return;

  try {
    const params = new URLSearchParams({
      page: String(rvPage),
      limit: '150',
      order: 'asc',
    });

    const res = await fetch(`/admin/api/replay/events/${rvTelegramId}?${params}`);
    const data = await res.json();

    rvEvents = data.data;
    rvUser = data.user;
    rvTotalPages = data.pages;

    // Update header
    document.getElementById('rv-avatar').textContent = (rvUser?.firstName || '?')[0].toUpperCase();
    document.getElementById('rv-name').innerHTML =
      escHtml(rvUser?.firstName ?? 'Unknown') +
      (rvUser?.username ? ` <span style="color:var(--t3);font-weight:400;">@${escHtml(rvUser.username)}</span>` : '') +
      (rvUser?.isPro ? ' <span class="pro-badge">PRO</span>' : '');
    document.getElementById('rv-meta').textContent =
      `${data.total} events · ${rvUser?.timezone ?? ''} · Joined ${new Date(rvUser?.createdAt).toLocaleDateString()}`;

    // Update footer
    document.getElementById('rv-event-count').textContent = `${data.total} events total · Page ${rvPage} of ${rvTotalPages}`;
    document.getElementById('rv-load-older').disabled = rvPage <= 1;
    document.getElementById('rv-load-newer').disabled = rvPage >= rvTotalPages;

    // Render events
    renderReplayEvents();

  } catch (err) {
    console.error('Failed to load replay events:', err);
    document.getElementById('rv-chat').innerHTML =
      '<div class="empty-state"><div class="empty-icon">⚠️</div>Failed to load session data.</div>';
  }
}

function renderReplayEvents() {
  const chat = document.getElementById('rv-chat');
  chat.innerHTML = '';

  // Filter events based on active filter
  let filtered = rvEvents;
  if (rvFilter === 'messages') {
    filtered = rvEvents.filter(e =>
      ['user_message', 'user_voice', 'bot_message', 'bot_photo', 'bot_edit'].includes(e.eventType)
    );
  } else if (rvFilter === 'errors') {
    filtered = rvEvents.filter(e => e.eventType === 'error');
  } else if (rvFilter === 'state') {
    filtered = rvEvents.filter(e => e.eventType === 'state_change');
  }

  if (filtered.length === 0) {
    chat.innerHTML = '<div class="empty-state"><div class="empty-icon">💬</div>No events to display.</div>';
    return;
  }

  let lastDate = '';

  filtered.forEach(event => {
    const ts = new Date(event.timestamp);
    const dateStr = ts.toLocaleDateString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric' });
    const timeStr = ts.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: true });

    // Insert date separator if new day
    if (dateStr !== lastDate) {
      lastDate = dateStr;
      const sep = document.createElement('div');
      sep.className = 'replay-date-sep';
      sep.innerHTML = `<span>${dateStr}</span>`;
      chat.appendChild(sep);
    }

    const p = event.payload;

    switch (event.eventType) {
      case 'user_message':
        chat.appendChild(createBubble('user', p.text, timeStr));
        break;

      case 'user_voice':
        chat.appendChild(createVoiceBubble(p.duration, timeStr));
        break;

      case 'user_callback':
        chat.appendChild(createActionPill(p.buttonLabel || p.data, timeStr));
        break;

      case 'bot_message':
        chat.appendChild(createBotBubble(p.text, timeStr, p.replyMarkup));
        break;

      case 'bot_photo':
        chat.appendChild(createPhotoBubble(p.caption, timeStr));
        break;

      case 'bot_edit':
        chat.appendChild(createBotBubble(p.newText, timeStr, p.replyMarkup, true));
        break;

      case 'error':
        chat.appendChild(createErrorBanner(p.errorMessage, p.context, p.errorStack, timeStr));
        break;

      case 'state_change':
        chat.appendChild(createStateChange(p.changes, timeStr));
        break;
    }
  });

  // Scroll to bottom
  rvScrollToBottom();
}

// ── Bubble Constructors ──────────────────────────────────────────────────

function createBubble(side, text, time) {
  const el = document.createElement('div');
  el.className = `replay-msg ${side}`;
  el.innerHTML = `
    <div>${formatMd(text)}</div>
    <div class="msg-time">${time}</div>
  `;
  return el;
}

function createBotBubble(text, time, replyMarkup, isEdited = false) {
  const el = document.createElement('div');
  el.className = 'replay-msg bot';

  let keyboardHtml = '';
  if (replyMarkup?.inline_keyboard) {
    keyboardHtml = '<div class="msg-keyboard">' +
      replyMarkup.inline_keyboard.map(row =>
        '<div class="msg-keyboard-row">' +
        row.map(btn =>
          `<div class="msg-kb-btn">${escHtml(btn.text)}</div>`
        ).join('') +
        '</div>'
      ).join('') +
      '</div>';
  }

  el.innerHTML = `
    <div>${formatMd(text)}${isEdited ? '<span class="edited-badge">(edited)</span>' : ''}</div>
    ${keyboardHtml}
    <div class="msg-time">${time}</div>
  `;
  return el;
}

function createPhotoBubble(caption, time) {
  const el = document.createElement('div');
  el.className = 'replay-msg bot-photo';
  el.innerHTML = `
    <div class="photo-placeholder">🖼️</div>
    <div class="photo-caption">${formatMd(caption)}</div>
    <div class="msg-time">${time}</div>
  `;
  return el;
}

function createVoiceBubble(duration, time) {
  const el = document.createElement('div');
  el.className = 'replay-msg voice';
  const mins = Math.floor(duration / 60);
  const secs = duration % 60;
  const durStr = `${mins}:${String(secs).padStart(2, '0')}`;
  el.innerHTML = `
    <span class="voice-icon">🎤</span>
    <div class="voice-bar"></div>
    <span class="voice-dur">${durStr}</span>
    <div class="msg-time">${time}</div>
  `;
  return el;
}

function createActionPill(label, time) {
  const el = document.createElement('div');
  el.className = 'replay-action';
  el.innerHTML = `<span class="action-icon">👆</span> ${escHtml(label)} <span style="font-size:10px;color:rgba(124,58,237,0.5);margin-left:4px;">${time}</span>`;
  return el;
}

function createErrorBanner(message, context, stack, time) {
  const el = document.createElement('div');
  el.className = 'replay-error';
  el.innerHTML = `
    <div class="error-title">⚠️ Error in ${escHtml(context || 'unknown')}</div>
    <div style="margin-bottom:4px;">${escHtml(message)}</div>
    ${stack ? `<div class="error-stack" onclick="this.classList.toggle('expanded')">${escHtml(stack)}</div>` : ''}
    <div style="font-size:10px;color:rgba(239,68,68,0.4);margin-top:4px;">${time}</div>
  `;
  return el;
}

function createStateChange(changes, time) {
  const el = document.createElement('div');
  el.className = 'replay-state';
  const parts = Object.entries(changes).map(([key, val]) => {
    const v = val;
    return `${key}: ${JSON.stringify(v.from)} → ${JSON.stringify(v.to)}`;
  });
  el.textContent = `⚙ ${parts.join(' · ')} · ${time}`;
  el.title = JSON.stringify(changes, null, 2);
  return el;
}

// ── Markdown formatter (basic — bold, italic, code) ──────────────────────
function formatMd(text) {
  if (!text) return '';
  return escHtml(text)
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/\*(.+?)\*/g, '<strong>$1</strong>')
    .replace(/_(.+?)_/g, '<em>$1</em>')
    .replace(/`(.+?)`/g, '<code style="background:rgba(255,255,255,0.08);padding:1px 4px;border-radius:3px;font-size:12px;">$1</code>')
    .replace(/\n/g, '<br>');
}

// ── Scroll ────────────────────────────────────────────────────────────────
function rvScrollToBottom() {
  const chat = document.getElementById('rv-chat');
  setTimeout(() => { chat.scrollTop = chat.scrollHeight; }, 50);
}

// ── Filters ───────────────────────────────────────────────────────────────
function setReplayFilter(filter, btn) {
  rvFilter = filter;
  document.querySelectorAll('.replay-filter-btn').forEach(b => b.classList.remove('active'));
  btn.classList.add('active');
  renderReplayEvents();
}

// ── Pagination ────────────────────────────────────────────────────────────
function rvLoadOlder() { if (rvPage > 1) { rvPage--; rvLoadEvents(); } }
function rvLoadNewer() { if (rvPage < rvTotalPages) { rvPage++; rvLoadEvents(); } }
```

### 6.5 — Panel Switching Integration

Update the existing `switchPanel` function to handle the replay panel:

```javascript
// Modify existing switchPanel function:
function switchPanel(name) {
  // Close replay viewer if switching away from replay
  if (name !== 'replay') {
    closeReplay();
  }

  document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
  document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));

  const panel = document.getElementById('panel-' + name);
  if (panel) panel.classList.add('active');

  const navItem = document.querySelector(`.nav-item[data-panel="${name}"]`);
  if (navItem) navItem.classList.add('active');

  // Load data for the panel
  if (name === 'replay') loadReplaySessions();
  // ... existing panel loading code ...
}
```

---

## 7. Data Retention & Cleanup

### 7.1 — Cron Job (In Existing Scheduler)

Add to `src/services/scheduler.ts`:

```typescript
// ── Replay event cleanup — runs daily at 3:00 AM ────────────────────────
cron.schedule("0 3 * * *", async () => {
  try {
    const cutoff = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000); // 30 days ago

    const result = await prisma.replayEvent.deleteMany({
      where: { timestamp: { lt: cutoff } },
    });

    if (result.count > 0) {
      console.log(`[scheduler] Cleaned up ${result.count} replay events older than 30 days`);
    }
  } catch (err) {
    console.error("[scheduler] Failed to clean up replay events:", err);
  }
});
```

### 7.2 — Manual Cleanup Script

Add `scripts/cleanup-replay-events.ts` for manual runs:

```typescript
// scripts/cleanup-replay-events.ts
import "dotenv/config";
import { PrismaClient } from "../src/prisma/client";

const prisma = new PrismaClient();

async function main() {
  const days = parseInt(process.argv[2] ?? "30", 10);
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  console.log(`Deleting replay events older than ${days} days (before ${cutoff.toISOString()})...`);

  const result = await prisma.replayEvent.deleteMany({
    where: { timestamp: { lt: cutoff } },
  });

  console.log(`Deleted ${result.count} events.`);
  await prisma.$disconnect();
}

main().catch(console.error);
```

Usage: `npx tsx scripts/cleanup-replay-events.ts 30`

---

## 8. Error Capture

### 8.1 — Comprehensive Error Capture Points

| Location | Error Type | Implementation |
|---|---|---|
| `bot.catch()` | Any unhandled grammY error | Global error boundary — catches everything that slips through |
| `handleAiRefine` catch | OpenAI API failures | `captureReplayError(telegramId, err, "handleAiRefine", chatId)` |
| `handleVoiceLog` catch | Whisper transcription failures | `captureReplayError(telegramId, err, "handleVoiceLog", chatId)` |
| `handleVoiceSave` catch | DB write failures | `captureReplayError(telegramId, err, "handleVoiceSave", chatId)` |
| `handleDoneLogging` catch (add one) | Log save failures | `captureReplayError(telegramId, err, "handleDoneLogging", chatId)` |
| `handlePayPaystack` catch | Paystack API failures | `captureReplayError(telegramId, err, "handlePayPaystack", chatId)` |
| `handleManualSent` catch (add one) | DB/admin notification failures | `captureReplayError(telegramId, err, "handleManualSent", chatId)` |
| `webhook:charge.success` catch | Webhook processing errors | `captureReplayError(telegramId, err, "webhook:charge.success")` |
| `scheduler:sendReminder` catch | Reminder delivery failures | `captureReplayError(job.telegramId, e, "scheduler:sendReminder")` |
| `handleFeedbackText` (add try/catch) | Feedback forwarding failures | `captureReplayError(telegramId, err, "handleFeedbackText", chatId)` |
| `handleSettingsTimeSelect` (add try/catch) | Settings update failures | `captureReplayError(telegramId, err, "handleSettingsTimeSelect", chatId)` |
| `handleEditText` (add try/catch) | Log edit failures | `captureReplayError(telegramId, err, "handleEditText", chatId)` |

### 8.2 — Global Error Boundary

```typescript
// Add to src/bot/index.ts AFTER all handlers
bot.catch((err) => {
  const ctx = err.ctx;
  const telegramId = BigInt(ctx.from?.id ?? 0);

  console.error(`[bot] Unhandled error for user ${telegramId}:`, err.error);

  captureReplayError(
    telegramId,
    err.error,
    `unhandled:${err.message?.slice(0, 100) ?? "unknown"}`,
    ctx.chat?.id,
  );
});
```

---

## 9. Performance Considerations

### 9.1 — Write Performance

| Concern | Solution |
|---|---|
| DB writes per message | **Batched inserts** — events buffer in memory and flush every 2s or every 50 events via `createMany` |
| Memory usage | Buffer capped at 500 events max (dropped if flush fails repeatedly) |
| Bot latency | All replay logging is fire-and-forget (no `await` in the hot path) |
| Graceful shutdown | `flushReplayBuffer()` called on SIGTERM/SIGINT |

### 9.2 — Read Performance

| Concern | Solution |
|---|---|
| Session list query | Raw SQL with `GROUP BY telegramId, MAX(timestamp)` — uses the composite index |
| Event fetching | Paginated (100-200 per page), uses `(telegramId, timestamp)` index |
| Client-side rendering | DOM elements created via `document.createElement` (no innerHTML loops for large datasets) |
| Large sessions | Lazy loading with "Load older ↑" / "Load newer ↓" buttons |

### 9.3 — Storage Estimates

For <10k active users:
- **Average events per user per day**: ~20-50 (messages + responses + callbacks + state changes)
- **Average payload size**: ~300 bytes
- **Per user per day**: ~6-15 KB
- **10k users × 30 days**: ~1.8-4.5 GB

This is well within PostgreSQL's comfort zone. No need for ClickHouse or object storage at this scale.

### 9.4 — Index Strategy

```
ReplayEvent_telegramId_timestamp_idx   — Primary query path (session events)
ReplayEvent_timestamp_idx              — Cleanup cron (DELETE by date)
```

Two indexes is the sweet spot. Adding more (e.g., on `eventType`) isn't worth the write overhead at this scale.

---

## 10. File-by-File Implementation Checklist

### New Files

| File | Purpose |
|---|---|
| `src/services/replayCapture.ts` | Event buffer, middleware, API wrapper, error capture helper |
| `scripts/cleanup-replay-events.ts` | Manual retention cleanup script |

### Modified Files

| File | Changes |
|---|---|
| `prisma/schema.prisma` | Add `ReplayEvent` model |
| `src/bot/index.ts` | Register `replayMiddleware()`, `replayTransformer`, `bot.catch()` error handler, import new service |
| `src/index.ts` | Add `flushReplayBuffer()` to shutdown handlers |
| `src/admin/router.ts` | Add 3 new API endpoints: `/api/replay/sessions`, `/api/replay/events/:telegramId`, `/api/replay/stats` |
| `src/admin/dashboard.html` | Add sidebar nav item, session list panel, replay viewer overlay, all CSS + JS |
| `src/services/scheduler.ts` | Add daily 3 AM cleanup cron for 30-day retention |
| `src/bot/aiFeatures.ts` | Add `captureReplayError` calls in catch blocks |
| `src/bot/logging.ts` | Add `captureReplayError` calls in catch blocks |
| `src/bot/payments.ts` | Add `captureReplayError` calls in catch blocks |
| `src/bot/feedback.ts` | Add `captureReplayError` calls in catch blocks |
| `src/bot/settings.ts` | Add `captureReplayError` calls in catch blocks |
| `src/bot/reminders.ts` | (No changes — scheduler handles errors) |

### Migration

```bash
npx prisma migrate dev --name add_replay_events
```

---

## 11. Testing Plan

### 11.1 — Verification Steps (Manual, Pre-Production)

1. **Start the bot** → `/start` → verify `user_message` and `bot_message` + `bot_photo` events are created in DB
2. **Complete onboarding** → verify `user_callback` events for frequency/time selections + `state_change` events
3. **Write a log** → send text → tap Done ✅ → verify full event chain captured
4. **Send voice note** → verify `user_voice` event + bot response chain
5. **Trigger an error** → (e.g., disconnect OpenAI key, try AI refine) → verify `error` event appears
6. **Open admin dashboard** → navigate to Session Replay tab → verify session list loads
7. **Click a session** → verify conversation renders with correct bubbles, dates, timestamps
8. **Filter by errors** → verify only error events shown
9. **Filter by messages** → verify only messages shown
10. **Pagination** → create >150 events, verify "Load older/newer" works
11. **Wait 2+ seconds** → verify buffered events are flushed to DB
12. **Kill process with Ctrl+C** → verify flush happens (check logs for "[shutdown] Flushing replay buffer...")

### 11.2 — SQL Verification Queries

```sql
-- Check events are being captured
SELECT "eventType", COUNT(*) FROM "ReplayEvent" GROUP BY "eventType";

-- Check a specific user's session
SELECT * FROM "ReplayEvent"
WHERE "telegramId" = 123456789
ORDER BY "timestamp" DESC
LIMIT 20;

-- Verify index is being used
EXPLAIN ANALYZE SELECT * FROM "ReplayEvent"
WHERE "telegramId" = 123456789
ORDER BY "timestamp" DESC
LIMIT 100;

-- Check storage size
SELECT pg_size_pretty(pg_total_relation_size('"ReplayEvent"'));
```

---

## 12. Rollback Strategy

If anything goes wrong in production:

### Quick Disable (No Deployment)

Comment out the middleware registration in `src/bot/index.ts`:

```typescript
// bot.use(replayMiddleware());        ← comment this out
// bot.api.config.use(replayTransformer); ← comment this out
```

This immediately stops all event capture. The admin UI will still show historical data but no new events will appear.

### Full Rollback

1. Revert the `src/bot/index.ts` changes
2. Revert the `src/index.ts` shutdown handler changes
3. The admin UI, API routes, and DB table can stay — they're inert without the capture middleware
4. Optionally drop the table: `DROP TABLE "ReplayEvent";` and rollback the migration

### Why This Is Safe

- The capture layer is **fully decoupled** from core bot logic
- All replay writes are fire-and-forget (never `await`ed in the handler path)
- The `try/catch` inside `flushBuffer` ensures DB failures don't crash the bot
- The buffer has a 500-event cap to prevent memory leaks
- Error capture calls are additive (they sit alongside existing `console.error` calls)

---

## Summary

| Component | Complexity | Risk |
|---|---|---|
| Prisma model + migration | Low | None — additive schema change |
| Event capture middleware | Medium | Low — middleware wraps, doesn't replace |
| API transformer (outgoing capture) | Medium | Low — grammY's transformer API is stable |
| Buffered writes | Medium | Low — fire-and-forget with size cap |
| API endpoints | Low | None — read-only, behind auth |
| Session list UI | Medium | None — frontend only |
| Replay viewer UI | High | None — frontend only, no bot impact |
| Error capture integration | Low | None — additive `captureReplayError` calls |
| Data retention cron | Low | None — simple DELETE with date filter |

**Total new lines of code**: ~1,200-1,500 (TypeScript) + ~800-1,000 (HTML/CSS/JS in dashboard)

**Expected implementation time**: The feature is entirely additive — no existing functionality is modified in a breaking way. The biggest piece is the replay viewer CSS/JS in the dashboard, which is pure frontend work with zero risk to the bot.
