import { InlineKeyboard } from "grammy";
import type { Message } from "grammy/types";
import { getDaysInMonth, startOfMonth, getDay, format } from "date-fns";
import { prisma } from "../lib/prisma";
import { Prisma } from "../prisma/client";
import { CatchupPaymentStatus, CatchupTier, TransactionStatus } from "../prisma/enums";
import type { BotContext, SessionData } from "./types";
import { clearActiveFlow } from "./types";
import { evaluateCatchupDump, generateCatchupLogs } from "../services/openai";
import { initializeCatchupPassTransaction, RESCUE_PASS_PAYMENT_TYPE } from "../services/paystack";
import { patchStoredSessionCatchup, readStoredSession } from "./sessionStorage";
import {
  getCatchupTierPrice,
  getCatchupTierUnit,
  getCatchupTotalBlocks,
  getMaxTierDuration,
  CATCHUP_BLOCK_CLAIM_LEASE_MS,
} from "../services/catchupTiers";
import { buildTimeKeyboard, createInitialReminderJobs, getMainMenuKeyboard } from "./onboarding";
import { hasActiveStorage } from "./monetization";
// NOTE: `bot` is only ever touched inside function bodies — the import cycle with
// ./index resolves lazily under CommonJS, so it is safe.
import { bot } from "./index";

// ----------------------------------------------------------------------------
// LOADING STATES
// One message that walks through the steps below every 5s, so a long generation
// never looks frozen. It runs until the caller's `finally` stops it, backed by
// an absolute time cap so a missed stopper cannot spin forever.
// ----------------------------------------------------------------------------

const LOADING_STEPS = [
  "Warming up...",
  "Analyzing... ",
  "Mapping missing days... ",
  "Drafting your logs... ",
];

/**
 * Absolute backstop. The cycler no longer self-clears at the last frame, so a
 * caller that never invoked its stopper would edit a message and fire a typing
 * action every 5s forever. Set beyond the worst-case generation (~30 min) so it
 * can only ever trip on a genuine leak, never during real work.
 */
const LOADING_CYCLER_MAX_MS = 40 * 60 * 1000;

/**
 * `fromStep` is the index of the NEXT frame; the caller has already sent
 * LOADING_STEPS[fromStep - 1] as the message being cycled.
 *
 * Cycles for as long as generation runs. It used to stop after the final frame,
 * which froze the message ~20s in while OpenAI kept working for minutes — the
 * user was left staring at a dead "Drafting your logs..." on a purchase they had
 * just made. The typing action is what actually reads as "alive" in Telegram;
 * the text rotation is secondary.
 *
 * CALLERS MUST invoke the returned stopper in a `finally`. There is no self-clear
 * any more, only the leak backstop above.
 */
export function startLoadingCycler(
  api: any,
  chatId: number | string,
  messageId: number,
  fromStep = 1,
) {
  const startedAt = Date.now();
  let step = fromStep;

  /** Telegram shows "typing..." for ~5s, which is exactly the tick interval. */
  const showTyping = () => {
    try {
      void Promise.resolve(api.sendChatAction(chatId, "typing")).catch(() => {});
    } catch {
      // best-effort only; never let this escape the timer callback
    }
  };

  showTyping(); // don't make the user wait 5s for the first sign of life

  const timer = setInterval(() => {
    if (Date.now() - startedAt > LOADING_CYCLER_MAX_MS) {
      clearInterval(timer);
      return;
    }

    showTyping();

    const current = step;
    // Wrap to 1, not 0. Re-showing "Warming up..." three minutes into a
    // generation reads as a crash-and-restart; every later frame stays honest.
    step = step + 1 >= LOADING_STEPS.length ? 1 : step + 1;

    try {
      // Promise.resolve guards a non-thenable return; the try/catch guards a
      // synchronous throw. Either would escape the timer callback as an
      // uncaughtException and leave this interval running until the backstop.
      void Promise.resolve(api.editMessageText(chatId, messageId, LOADING_STEPS[current]))
        .catch(() => {});
    } catch {
      // 400 "message is not modified", a deleted message, or a malformed api.
    }
  }, 5000);

  timer.unref?.(); // never hold the event loop open during shutdown

  return () => clearInterval(timer);
}

// ----------------------------------------------------------------------------
// CALENDAR GENERATOR
// ----------------------------------------------------------------------------
export function generateCatchupCalendar(year: number, month: number, mode: 'start' | 'end'): InlineKeyboard {
  const kb = new InlineKeyboard();
  const date = new Date(year, month);
  
  // Row 1: Header
  const title = `${format(date, 'MMMM yyyy')} (${mode === 'start' ? 'Start Date' : 'End Date'})`;
  kb.text(title, "ccal_noop").row();

  // Row 2: Days of the week
  const days = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  days.forEach(d => kb.text(d, "ccal_noop"));
  kb.row();

  // Row 3+: The actual dates
  const startingDayOfWeek = getDay(startOfMonth(date)); // 0 = Sunday
  const daysInMonth = getDaysInMonth(date);

  let currentColumn = 0;
  for (let i = 0; i < startingDayOfWeek; i++) {
    kb.text(" ", "ccal_noop");
    currentColumn++;
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    kb.text(String(day), `ccal_sel_${mode}_${dateStr}`);
    
    currentColumn++;
    if (currentColumn === 7) {
      kb.row();
      currentColumn = 0;
    }
  }

  if (currentColumn > 0 && currentColumn < 7) {
    for (let i = currentColumn; i < 7; i++) {
      kb.text(" ", "ccal_noop");
    }
    kb.row();
  }

  // Navigation Row: < Prev | Cancel | Next >
  const prevMonth = month === 0 ? 11 : month - 1;
  const prevYear = month === 0 ? year - 1 : year;
  const nextMonth = month === 11 ? 0 : month + 1;
  const nextYear = month === 11 ? year + 1 : year;

  kb.text("Prev", `ccal_nav_${mode}_${prevYear}_${prevMonth}`);
  kb.text("Cancel", "ccal_cancel");
  kb.text("Next", `ccal_nav_${mode}_${nextYear}_${nextMonth}`);

  // Own row so it never competes with month navigation. Built here rather than
  // at the call site so it survives Prev/Next, which re-render the whole board.
  kb.row().text("Back", "catchup_back_duration");

  return kb;
}

/**
 * VIP_DEFENSE is deliberately absent — the tier is retired at the UI layer only.
 * The enum value, its price, and its duration cap all stay put so sessions and
 * invoices created before the retirement still resolve correctly.
 */
function generateCatchupTierKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("A Few Weeks (Max 4)", "catchup_tier_QUICK_FIX")
    .row()
    .text("2 to 6 Months", "catchup_tier_FULL_BACKLOG");
}

/** Tiers a user is allowed to newly select. Retired tiers stay out of this list. */
const SELECTABLE_CATCHUP_TIERS = ["QUICK_FIX", "FULL_BACKLOG"] as const;

// ----------------------------------------------------------------------------
// WORKPLACE ROLE VALIDATION
// `workplaceRole` is the single strongest signal the generator has. A greeting
// saved into it silently degrades every future log, so both capture points run
// the same check rather than trusting a bare length test.
// ----------------------------------------------------------------------------

const CONVERSATIONAL_REPLIES = new Set([
  "hi", "hii", "hiii", "hey", "heyy", "hello", "helo", "hallo", "yo", "hola",
  "ok", "okay", "okk", "oky", "kk", "yes", "yeah", "yep", "no", "nope", "nah",
  "help", "thanks", "thank you", "thankyou", "tanks", "thx", "ty",
  "please", "pls", "abeg", "sure", "fine", "good", "great", "nice", "cool",
  "hmm", "hmmm", "start", "menu", "cancel", "done", "test", "testing",
  "morning", "good morning", "good afternoon", "good evening", "how are you",
]);

/**
 * Rejects greetings and filler so they never reach `User.workplaceRole`.
 * Exported because index.ts captures the same field on the AI-refine path.
 */
export function isPlausibleWorkplaceRole(text: string): boolean {
  const trimmed = text.trim();
  if (trimmed.length < 4) return false;

  const normalized = trimmed
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  if (!normalized) return false;
  return !CONVERSATIONAL_REPLIES.has(normalized);
}

/**
 * Asked at three points: before pricing for deep-link arrivals, after the date
 * picker, and mid-flow if the role is still missing. Single-sourced so the
 * wording cannot drift between them.
 */
const WORKPLACE_ROLE_QUESTION =
  "Before I write this, what exactly is your job role and department at your IT placement?";

/**
 * The brain-dump ask, assembled from one template.
 *
 * Only the opener and the period change between the four entry points (weeks or
 * months, first ask or the repeat after the role question). Everything from
 * "Drop the projects" onward is shared, so a copy edit lands in one place and
 * the tiers cannot end up reading differently on the same screen.
 *
 * `lead` carries the greeting through the verb, e.g. "Perfect. Tell me" or
 * "Got it! Now, tell me". `period` is the span, e.g. "this entire 3-week
 * period" or "*June*".
 */
function buildCatchupDumpPrompt(lead: string, period: string): string {
  return (
    `${lead} everything you worked on during ${period}. ` +
    "Drop the projects, tools, challenges, and lessons. Tell me all the deets 🤭\n\n" +
    "(You can type it out, or just send a voice note)"
  );
}

/** The exact rejection shown at every workplace-role capture point. */
export const INVALID_ROLE_REPLY =
  "That doesn't look like a job role 😅 Please reply with your actual position so I can write accurate logs for you.";

/** The standard sign-off, shared with the stuck-on-generating recovery. */
const ALL_DONE_MESSAGE = "All done, your logs have been generated and stored. View them here.";

/**
 * Shown when a paid user messages while their block is still being written.
 * Generation runs for minutes, so this is a routine thing for them to do.
 */
const STILL_GENERATING_MESSAGE =
  "Still writing your logs, hang tight. I'll send them here the moment they're ready.";

/**
 * Shown when a block completed but wrote nothing, because every date in its
 * range already had a log. Used INSTEAD of any "all done" claim.
 */
const ZERO_NEW_LOGS_MESSAGE =
  "It looks like you already have logs saved for all these dates! 😅 No new logs were added.";

/**
 * Durations offered per tier, so the user taps instead of typing a number.
 *
 * The set is tier-derived rather than a fixed list, because the tier already
 * fixes the unit and the price: offering "1 Week" under FULL_BACKLOG would sell
 * a week at the six-month price. QUICK_FIX starts at 1 week; FULL_BACKLOG starts
 * at 2 months, matching what its own button advertises (anyone wanting a single
 * month is better served by 4 weeks on the cheaper tier).
 */
function getCatchupDurationOptions(tier: CatchupTier): number[] {
  const first = tier === CatchupTier.QUICK_FIX ? 1 : 2;
  const options: number[] = [];
  for (let n = first; n <= getMaxTierDuration(tier); n++) options.push(n);
  return options;
}

function generateCatchupDurationKeyboard(tier: CatchupTier): InlineKeyboard {
  const kb = new InlineKeyboard();
  const unit = getCatchupTierUnit(tier) === "weeks" ? "Week" : "Month";

  getCatchupDurationOptions(tier).forEach((n, index) => {
    kb.text(`${n} ${unit}${n === 1 ? "" : "s"}`, `cdur_${n}`);
    if ((index + 1) % 3 === 0) kb.row();
  });

  // Back returns to the tier keyboard, so a wrong plan is one tap to undo.
  return kb.row().text("Back", "catchup_back_tier").text("Cancel", "ccal_cancel");
}

async function getCatchupSessionForCurrentUser(ctx: BotContext) {
  const sessionId = ctx.session.catchupSessionId;
  if (sessionId) {
    const byId = await prisma.catchupSession.findUnique({ where: { id: sessionId } });
    if (byId) return byId;
  }

  const telegramId = BigInt(ctx.from!.id);
  const user = await prisma.user.findUnique({ where: { telegramId }, select: { id: true } });
  if (!user) return null;

  return prisma.catchupSession.findFirst({
    where: { userId: user.id },
    orderBy: { createdAt: "desc" },
  });
}

type CatchupBlockDump = { block: number; entries: string[] };

type CatchupContextDump = {
  blocks: CatchupBlockDump[];
  // Legacy rows may also carry `task` / `weeklySummary`; both are ignored now
  // that entries are a single raw string.
  week1Preview?: Array<{
    dateOffset: number;
    content: string;
  }>;
  fulfilledBlocks?: number[];
};

function normalizeContextDump(contextDump: unknown): CatchupBlockDump[] {
  if (!contextDump) return [];

  if (Array.isArray(contextDump)) {
    return contextDump
      .map((entry) => {
        if (!entry || typeof entry !== "object") return null;
        const candidate = entry as { block?: unknown; entries?: unknown; text?: unknown };
        const block = Number(candidate.block);
        if (!Number.isFinite(block)) return null;
        const entries = Array.isArray(candidate.entries)
          ? candidate.entries.filter((item): item is string => typeof item === "string")
          : typeof candidate.text === "string"
            ? [candidate.text]
            : [];
        return { block, entries };
      })
      .filter((entry): entry is CatchupBlockDump => Boolean(entry));
  }

  if (typeof contextDump === "object") {
    const legacy = contextDump as { blocks?: unknown };
    if (Array.isArray(legacy.blocks)) return normalizeContextDump(legacy.blocks);
  }

  return [];
}

type CatchupPreviewLog = NonNullable<CatchupContextDump["week1Preview"]>[number];

type NormalizedContextPayload = {
  blocks: CatchupBlockDump[];
  week1Preview: CatchupPreviewLog[];
  fulfilledBlocks: number[];
};

/** Reads the whole contextDump payload (blocks + week-1 preview + fulfilment ledger). */
function readContextPayload(contextDump: unknown): NormalizedContextPayload {
  const blocks = normalizeContextDump(contextDump);
  const payload = contextDump && typeof contextDump === "object" && !Array.isArray(contextDump)
    ? (contextDump as CatchupContextDump)
    : undefined;

  return {
    blocks,
    week1Preview: Array.isArray(payload?.week1Preview) ? payload!.week1Preview : [],
    fulfilledBlocks: Array.isArray(payload?.fulfilledBlocks)
      ? payload!.fulfilledBlocks.filter((block): block is number => Number.isFinite(block))
      : [],
  };
}

function buildContextDump(payload: NormalizedContextPayload): Prisma.InputJsonValue {
  const dump: Record<string, unknown> = {
    blocks: payload.blocks,
    fulfilledBlocks: payload.fulfilledBlocks,
  };
  if (payload.week1Preview.length > 0) dump.week1Preview = payload.week1Preview;
  return dump as Prisma.InputJsonValue;
}

// ----------------------------------------------------------------------------
// BLOCK MATH
// A "block" is one generation chunk. QUICK_FIX is a single block covering the
// whole 1–4 week period; the longer tiers use one block per month, so their
// totalDuration is the block count.
// ----------------------------------------------------------------------------

const WORKING_DAYS_PER_WEEK = 5;
const WORKING_DAYS_PER_MONTH = 20;

const MONTH_NAMES = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

/**
 * Calendar month name for a given block, anchored on the session's startDate.
 * Block 1 is the month the user started in, block 2 the one after, etc.
 *
 * Read in UTC on purpose — startDate is stored as midnight UTC (see DATE
 * HELPERS), so date-fns `format` would resolve to the previous day, and
 * therefore the previous month, on any host west of UTC.
 */
function getBlockMonthName(startDate: Date, blockIndex: number): string {
  const monthOffset = new Date(startDate).getUTCMonth() + Math.max(1, blockIndex) - 1;
  return MONTH_NAMES[((monthOffset % 12) + 12) % 12];
}

// ----------------------------------------------------------------------------
// OUT-OF-CONTEXT HELPERS
// Fulfilment is triggered by the Paystack webhook, so there is no `ctx` — we
// message through bot.api and patch the Prisma-backed session row directly.
// ----------------------------------------------------------------------------

async function notifyCatchupUser(
  telegramId: bigint,
  text: string,
  extra?: Parameters<typeof bot.api.sendMessage>[2],
): Promise<Message | undefined> {
  try {
    return await bot.api.sendMessage(Number(telegramId), text, extra);
  } catch (err) {
    console.error(`[catchup] Failed to notify user ${telegramId}:`, err);
    return undefined;
  }
}

type StoredCatchupState = NonNullable<SessionData["catchup"]>;

/** Merges a patch into the stored grammY session's `catchup` state (no ctx needed). */
async function patchStoredCatchupState(
  telegramId: bigint,
  patch: Partial<StoredCatchupState>,
  opts?: { clearSessionId?: boolean },
): Promise<void> {
  const key = telegramId.toString();

  try {
    // Compare-and-swap + a `catchupRev` bump, so a user message that is already
    // mid-flight cannot write its stale session snapshot over this patch.
    await patchStoredSessionCatchup(key, (sessionData) => {
      sessionData.catchup = { ...(sessionData.catchup ?? {}), ...patch };
      if (opts?.clearSessionId) delete sessionData.catchupSessionId;
    });
  } catch (err) {
    console.error(`[catchup] Failed to patch session state for ${telegramId}:`, err);
  }
}

async function appendCatchupDumpToSession(ctx: BotContext, text: string) {
  const catchupSession = await getCatchupSessionForCurrentUser(ctx);
  if (!catchupSession) return null;

  const blocks = normalizeContextDump(catchupSession.contextDump);
  const existingPayload = catchupSession.contextDump && typeof catchupSession.contextDump === "object" && !Array.isArray(catchupSession.contextDump)
    ? (catchupSession.contextDump as CatchupContextDump)
    : undefined;
  const currentBlockIndex = Math.max(1, catchupSession.currentBlock);
  const currentBlock = blocks.find((block) => block.block === currentBlockIndex);

  if (currentBlock) {
    currentBlock.entries.push(text);
  } else {
    blocks.push({ block: currentBlockIndex, entries: [text] });
  }

  await prisma.catchupSession.update({
    where: { id: catchupSession.id },
    data: {
      contextDump: {
        blocks,
        week1Preview: existingPayload?.week1Preview,
        fulfilledBlocks: existingPayload?.fulfilledBlocks,
      },
    },
  });

  // Only this block's entries — the caller must never evaluate a new month
  // against text the user wrote for a previous one.
  const currentEntries = blocks.find((block) => block.block === currentBlockIndex)?.entries ?? [];

  return { catchupSession, blocks, currentBlockIndex, currentEntries };
}

async function evaluateCurrentCatchupChunk(ctx: BotContext, rawText: string, opts?: { afterMoreDetail?: boolean }): Promise<void> {
  const catchupSession = await getCatchupSessionForCurrentUser(ctx);
  if (!catchupSession) {
    await ctx.reply("I couldn't find this catch-up session. Please type /catchup again.");
    return;
  }

  const user = await prisma.user.findUnique({
    where: { id: catchupSession.userId },
    select: { workplaceRole: true },
  });
  const workplaceRole = user?.workplaceRole?.trim() ?? "";

  if (!workplaceRole) {
    ctx.session.catchup = {
      active: true,
      step: 'awaiting_course',
      startedAt: ctx.session.catchup?.startedAt ?? Date.now(),
    };

    await ctx.reply(WORKPLACE_ROLE_QUESTION);
    return;
  }

  const evaluation = await evaluateCatchupDump(
    rawText,
    catchupSession.tierSelected,
    catchupSession.totalDuration,
    workplaceRole,
  );

  if (!evaluation.sufficientForCurrentChunk) {
    // NOTE: paymentStatus is NOT touched here — it now tracks the real Paystack
    // charge, and this session may already be PAID (blocks 2..n).
    ctx.session.catchup = {
      active: true,
      step: 'awaiting_more_detail',
      startedAt: ctx.session.catchup?.startedAt ?? Date.now(),
    };

    const questions = evaluation.followUpQuestions.length
      ? evaluation.followUpQuestions.map((question) => `• ${question}`).join("\n")
      : "• Tell me a bit more about the tools, projects, and technical problems you handled.";

    await ctx.reply(`I need a bit more to work with. 🤔\n\n${questions}`);
    return;
  }

  // Blocks 2..n are already covered by the Rescue Pass payment — no second
  // paywall, generate straight away.
  if (catchupSession.paymentStatus === CatchupPaymentStatus.PAID) {
    ctx.session.catchup = {
      active: true,
      step: 'generating',
      startedAt: ctx.session.catchup?.startedAt ?? Date.now(),
    };

    await ctx.reply("Perfect, that's solid detail. Writing these up now, give me a moment.");
    await resumeCatchupGeneration(catchupSession.id, ctx);
    return;
  }

  ctx.session.catchup = {
    active: true,
    step: 'ready_for_week_1_generation',
    startedAt: ctx.session.catchup?.startedAt ?? Date.now(),
  };

  await ctx.reply("Perfect, that's solid detail. Generating your first week now to show you how this looks...");
  await sendWeekOneBait(ctx);
}

/**
 * Renders one preview day. The date line is Telegram chrome so the user can tell
 * the samples apart — the entry itself is printed raw, exactly as it will be
 * saved, so what they see is what they copy.
 */
function formatWeekOneLog(log: { dateOffset: number; content: string }, date: Date, dayNumber: number): string {
  const dateLabel = format(date, "EEE, d MMM yyyy");
  return `*Day ${dayNumber}* • ${dateLabel}\n\n${log.content}`;
}

async function sendWeekOneBait(ctx: BotContext): Promise<void> {
  const catchupSession = await getCatchupSessionForCurrentUser(ctx);
  if (!catchupSession) {
    await ctx.reply("I couldn't find this catch-up session. Please type /catchup again.");
    return;
  }

  const user = await prisma.user.findUnique({
    where: { id: catchupSession.userId },
    select: { workplaceRole: true },
  });
  const workplaceRole = user?.workplaceRole?.trim() || "IT";

  const rawDump = normalizeContextDump(catchupSession.contextDump)
    .flatMap((block) => block.entries)
    .join("\n\n");

  const loadingMsg = await ctx.reply(LOADING_STEPS[0]);
  const stopLoading = startLoadingCycler(ctx.api, ctx.chat!.id, loadingMsg.message_id);

  let generated: Awaited<ReturnType<typeof generateCatchupLogs>>;
  try {
    generated = await generateCatchupLogs(
      rawDump,
      catchupSession.totalDuration,
      workplaceRole,
      5,
    );
  } finally {
    stopLoading();
    await ctx.api.deleteMessage(ctx.chat!.id, loadingMsg.message_id).catch(() => {});
  }

  const startDate = new Date(catchupSession.startDate);
  const logs = generated.logs.slice(0, 5);

  for (let index = 0; index < logs.length; index++) {
    const log = logs[index];
    const date = nthWorkingDayFrom(startDate, log.dateOffset);
    const formattedLog = formatWeekOneLog(log, date, index + 1);

    // The entry is now printed raw, so an underscore or asterisk in the model's
    // prose (snake_case, a * in a formula) makes Telegram reject the whole
    // message as unparseable Markdown. Falling back to plain text keeps the
    // paywall preview intact instead of failing the flow right before checkout.
    await ctx.reply(formattedLog, { parse_mode: "Markdown" }).catch(() => ctx.reply(formattedLog));
  }

  await prisma.catchupSession.update({
    where: { id: catchupSession.id },
    data: {
      contextDump: buildContextDump({
        ...readContextPayload(catchupSession.contextDump),
        week1Preview: logs,
      }),
    },
  });

  await ctx.reply(
    "Week 1 is locked in and perfectly formatted.",
    {
      reply_markup: new InlineKeyboard()
        .text("Approve and continue", "catchup_approve_wk1")
        .text("Tweak Week 1", "catchup_tweak_wk1"),
    },
  );
}

// ----------------------------------------------------------------------------
// RESCUE PASS — INVOICE
// ----------------------------------------------------------------------------

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

type CatchupSessionLike = { id: string; userId: number; tierSelected: CatchupTier; totalDuration: number };

/** How long a pending Paystack link is considered still usable. */
const PENDING_INVOICE_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Finds the still-open invoice for this session so a second tap re-sends the
 * same link instead of minting a second chargeable one.
 *
 * The checkout URL is derived from Paystack's access code, not the reference, so
 * it cannot be rebuilt from the reference alone — it is stored on the
 * transaction at creation time and read back here. Rows written before that
 * (or older than the TTL) return null so a fresh link is issued.
 */
async function findReusablePendingInvoice(
  catchupSession: CatchupSessionLike,
): Promise<{ authorization_url: string; reference: string } | null> {
  const existingPending = await prisma.paymentTransaction.findFirst({
    where: {
      userId: catchupSession.userId,
      status: TransactionStatus.PENDING,
      metadata: {
        path: ["catchup_session_id"],
        equals: catchupSession.id,
      },
      createdAt: { gte: new Date(Date.now() - PENDING_INVOICE_TTL_MS) },
    },
    orderBy: { createdAt: "desc" },
  });

  if (!existingPending) return null;

  const storedUrl = (existingPending.metadata as { authorization_url?: unknown } | null)?.authorization_url;
  if (typeof storedUrl !== "string" || !storedUrl) return null;

  return { authorization_url: storedUrl, reference: existingPending.reference };
}

type RescuePassInvoice = { authorization_url: string; reference: string };

/**
 * De-duplicates concurrent invoice minting, keyed by catch-up session.
 *
 * `findReusablePendingInvoice` is a read-then-write with no lock: two taps on
 * "Approve and continue" landing together both read "no pending invoice" and both
 * called Paystack, producing two live links with different references. Nothing
 * downstream reconciles that, so the user could pay twice. Both callers now await
 * the same promise and receive the same link.
 *
 * In-process only, which covers this deployment (one Node process serves both the
 * bot and the webhook). A second instance would need a DB-level unique index on
 * the pending (session, status) pair.
 */
const inFlightRescueInvoices = new Map<string, Promise<RescuePassInvoice>>();

async function getOrCreateRescuePassInvoice(
  catchupSession: CatchupSessionLike,
  email: string,
): Promise<RescuePassInvoice & { deduped: boolean }> {
  const pending = inFlightRescueInvoices.get(catchupSession.id);
  if (pending) {
    console.log(`[catchup] Joining in-flight invoice creation for session ${catchupSession.id}`);
    return { ...(await pending), deduped: true };
  }

  const amountKobo = getCatchupTierPrice(catchupSession.tierSelected) * 100;

  const work = (async (): Promise<RescuePassInvoice> => {
    const reusable = await findReusablePendingInvoice(catchupSession);
    if (reusable) {
      console.log(`[catchup] Reusing pending Rescue Pass invoice ${reusable.reference} for session ${catchupSession.id}`);
      return reusable;
    }

    const created = await initializeCatchupPassTransaction(email, amountKobo, catchupSession.id);

    await prisma.paymentTransaction.create({
      data: {
        userId: catchupSession.userId,
        amount: amountKobo,
        currency: "NGN",
        provider: "paystack",
        reference: created.reference,
        metadata: {
          payment_type: RESCUE_PASS_PAYMENT_TYPE,
          catchup_session_id: catchupSession.id,
          tier: catchupSession.tierSelected,
          // Needed to re-send this exact link instead of minting another charge.
          authorization_url: created.authorization_url,
        },
        // status defaults to PENDING; paidAt stays null until the charge lands.
      },
    });

    return created;
  })();

  inFlightRescueInvoices.set(catchupSession.id, work);
  try {
    return { ...(await work), deduped: false };
  } finally {
    inFlightRescueInvoices.delete(catchupSession.id);
  }
}

/**
 * Generates the Paystack link for the Rescue Pass, records the pending
 * PaymentTransaction, and sends the invoice with the manual-check button.
 * Re-sends the existing link when one is already open for this session.
 */
async function sendRescuePassInvoice(
  ctx: BotContext,
  catchupSession: CatchupSessionLike,
  email: string,
): Promise<void> {
  const priceNaira = getCatchupTierPrice(catchupSession.tierSelected);

  const { authorization_url, reference, deduped } = await getOrCreateRescuePassInvoice(
    catchupSession,
    email,
  );

  ctx.session.pendingPaystackRef = reference;

  // The tap we raced with is already sending this exact invoice. Keep the state
  // write above (same reference), but do not post a duplicate message.
  if (deduped) {
    ctx.session.catchup = {
      active: true,
      step: 'awaiting_payment',
      startedAt: ctx.session.catchup?.startedAt ?? Date.now(),
    };
    return;
  }

  ctx.session.catchup = {
    active: true,
    step: 'awaiting_payment',
    startedAt: ctx.session.catchup?.startedAt ?? Date.now(),
  };

  const unit = getCatchupTierUnit(catchupSession.tierSelected);
  const unitLabel = catchupSession.totalDuration === 1 ? unit.slice(0, -1) : unit;
  // "3 months" for the body, "3 Months" for the headline.
  const coverage = `${catchupSession.totalDuration} ${unitLabel}`;
  const coverageTitle = `${catchupSession.totalDuration} ${unitLabel.charAt(0).toUpperCase()}${unitLabel.slice(1)}`;

  await ctx.reply(
    `Get ${coverageTitle} of Logs, Filled For You, asap\n\n` +
      `${coverage} of logs. Done in minutes, not weeks.\n\n` +
      `₦${priceNaira.toLocaleString("en-NG")}\n\n` +
      `Pay securely with Paystack below.\n` +
      `The moment it clears, your logs are ready to copy straight into your logbook.\n\n` +
      `\`Ref: ${reference}\``,
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard()
        .url("Pay with Paystack", authorization_url)
        .row()
        .text("I have paid", "check_payment"),
    },
  );
}

/** Sends the invoice, or asks for a receipt email first if we don't have one. */
async function startRescuePassCheckout(ctx: BotContext, catchupSession: CatchupSessionLike): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { id: catchupSession.userId },
    select: { paymentEmail: true },
  });

  if (!user?.paymentEmail) {
    ctx.session.catchup = {
      active: true,
      step: 'awaiting_payment_email',
      startedAt: ctx.session.catchup?.startedAt ?? Date.now(),
    };

    await ctx.reply("Almost there. What email should I send the receipt to?");
    return;
  }

  await ctx.reply("Generating your secure payment link, one sec...");

  try {
    await sendRescuePassInvoice(ctx, catchupSession, user.paymentEmail);
  } catch (err) {
    console.error("[catchup] initializeCatchupPassTransaction failed:", err);
    await ctx.reply("I couldn't generate a payment link right now. Please try again in a moment.");
  }
}

// ----------------------------------------------------------------------------
// RESCUE PASS — FULFILMENT
// ----------------------------------------------------------------------------

/**
 * Marks a Rescue Pass charge as paid: flips the CatchupSession to PAID and
 * upserts the PaymentTransaction row for this reference.
 * Shared by the Paystack webhook and the "I have paid" manual check.
 */
export async function markRescuePassPaid(params: {
  catchupSessionId: string;
  reference: string;
  amount: number;
  currency?: string;
  paidAt: Date;
  providerMetadata?: unknown;
}) {
  const catchupSession = await prisma.catchupSession.findUnique({
    where: { id: params.catchupSessionId },
    select: { id: true, userId: true, paymentStatus: true, user: { select: { telegramId: true } } },
  });

  if (!catchupSession) {
    console.warn(`[catchup] Rescue Pass paid for unknown session ${params.catchupSessionId}`);
    return null;
  }

  const metadata = {
    payment_type: RESCUE_PASS_PAYMENT_TYPE,
    catchup_session_id: catchupSession.id,
    paystack: (params.providerMetadata ?? null) as Prisma.InputJsonValue,
  } as Prisma.InputJsonValue;

  try {
    await prisma.$transaction([
      prisma.catchupSession.update({
        where: { id: catchupSession.id },
        data: { paymentStatus: CatchupPaymentStatus.PAID },
      }),
      prisma.paymentTransaction.upsert({
        where: { reference: params.reference },
        update: {
          status: TransactionStatus.SUCCESS,
          paidAt: params.paidAt,
          amount: params.amount,
          metadata,
        },
        create: {
          userId: catchupSession.userId,
          amount: params.amount,
          currency: params.currency ?? "NGN",
          provider: "paystack",
          reference: params.reference,
          metadata,
          status: TransactionStatus.SUCCESS,
          paidAt: params.paidAt,
        },
      }),
    ]);
  } catch (err) {
    // Simultaneous deliveries of the same event both see "no row" and both try to
    // insert; the loser hits the unique index on `reference` and rolls the whole
    // transaction back — including the PAID flip. The winner already recorded the
    // charge, so treat this as done rather than 500ing and forcing a retry.
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      console.log(`[catchup] Rescue Pass ${params.reference} already recorded by a concurrent delivery.`);
      await prisma.catchupSession.update({
        where: { id: catchupSession.id },
        data: { paymentStatus: CatchupPaymentStatus.PAID },
      });
      return catchupSession;
    }
    throw err;
  }

  return catchupSession;
}

/** A block claim older than this is treated as abandoned (the worker died). */
const BLOCK_CLAIM_LEASE_MS = CATCHUP_BLOCK_CLAIM_LEASE_MS;

/**
 * Reclaims a block whose claim was never released.
 *
 * The claim advances `currentBlock` before the OpenAI call and the `catch`
 * releases it on error — but a SIGKILL/OOM between the two runs no `catch` at
 * all, leaving `currentBlock` advanced with the block absent from
 * `fulfilledBlocks`. That state is unfulfillable forever: the block is neither
 * "already done" nor claimable, so a paid session silently produces nothing.
 *
 * `updatedAt` doubles as the claim timestamp — taking the claim is itself a
 * write, and the only other write during generation is the ledger commit, which
 * releases it. The reclaim is a CAS on (currentBlock, updatedAt), so a worker
 * that is genuinely still running cannot have its claim stolen.
 *
 * Returns the reclaimed block index, or null if there was nothing to reclaim.
 */
async function reclaimAbandonedBlock(session: {
  id: string;
  currentBlock: number;
  updatedAt: Date;
  contextDump: unknown;
}): Promise<number | null> {
  const claimed = session.currentBlock - 1;
  if (claimed < 1) return null;

  // Fulfilled means the claim was released the happy way — nothing to reclaim.
  if (readContextPayload(session.contextDump).fulfilledBlocks.includes(claimed)) return null;

  // Inside the lease: assume a worker is still generating.
  if (Date.now() - session.updatedAt.getTime() < BLOCK_CLAIM_LEASE_MS) return null;

  const released = await prisma.catchupSession.updateMany({
    where: { id: session.id, currentBlock: session.currentBlock, updatedAt: session.updatedAt },
    data: { currentBlock: claimed },
  });

  if (released.count === 0) return null;

  console.warn(`[catchup] Reclaimed abandoned block ${claimed} of session ${session.id}`);
  return claimed;
}

/**
 * Re-drives paid sessions whose block claim was orphaned by a crash. Safe to run
 * on every boot: sessions that finished cleanly have their final block in
 * `fulfilledBlocks`, so the reclaim declines and the normal guards skip them.
 */
export async function sweepAbandonedCatchupBlocks(): Promise<void> {
  try {
    // `gte: 1`, NOT `gt: 1`. The claim increments currentBlock, so a process that
    // died between markRescuePassPaid and the claim leaves the session paid at
    // block 1 — which `gt: 1` excluded, stranding that user permanently with no
    // Paystack retry (the webhook already 200'd). Sessions that finished cleanly
    // are still cheap to include: currentBlock has advanced past totalBlocks, so
    // resumeCatchupGeneration's guards return immediately.
    const stale = await prisma.catchupSession.findMany({
      where: {
        paymentStatus: CatchupPaymentStatus.PAID,
        currentBlock: { gte: 1 },
        updatedAt: { lt: new Date(Date.now() - BLOCK_CLAIM_LEASE_MS) },
      },
      select: { id: true },
    });

    if (stale.length === 0) return;
    console.log(`[catchup] Sweeping ${stale.length} possibly-abandoned catch-up session(s)...`);

    for (const session of stale) {
      await resumeCatchupGeneration(session.id).catch((err) => {
        console.error(`[catchup] Sweep failed for session ${session.id}:`, err);
      });
    }
  } catch (err) {
    console.error("[catchup] Abandoned-block sweep failed:", err);
  }
}

/**
 * Generates and saves every remaining log for the session's current block, then
 * either asks for the next block's brain-dump or closes the session out.
 *
 * Concurrency is handled by an atomic claim on `currentBlock` (see below), not
 * by an in-process guard — the webhook and the manual "I have paid" check can
 * land in different processes.
 */
export async function resumeCatchupGeneration(sessionId: string, ctx?: BotContext): Promise<void> {
  /** Set once this call owns the block, so the claim can be released on failure. */
  let claimedBlock: number | null = null;

  /** Keeps the stored session and the live ctx session in sync. */
  const syncCatchupState = async (
    tid: bigint,
    patch: Partial<StoredCatchupState>,
    opts?: { clearSessionId?: boolean },
  ) => {
    await patchStoredCatchupState(tid, patch, opts);
    if (ctx?.from && BigInt(ctx.from.id) === tid) {
      ctx.session.catchup = { ...(ctx.session.catchup ?? { active: false, step: 'none' }), ...patch };
      if (opts?.clearSessionId) ctx.session.catchupSessionId = undefined;
    }
  };

  try {
    const catchupSession = await prisma.catchupSession.findUnique({
      where: { id: sessionId },
      include: { user: { select: { id: true, telegramId: true, workplaceRole: true } } },
    });

    if (!catchupSession) {
      console.warn(`[catchup] resumeCatchupGeneration — session ${sessionId} not found`);
      return;
    }

    const telegramId = catchupSession.user.telegramId;
    const payload = readContextPayload(catchupSession.contextDump);

    let blockIndex = Math.max(1, catchupSession.currentBlock);
    // If a previous worker was killed mid-generation, take its orphaned claim
    // back before the guards below decide this session has nothing left to do.
    const reclaimed = await reclaimAbandonedBlock(catchupSession);
    if (reclaimed !== null) blockIndex = reclaimed;
    // QUICK_FIX (1–4 weeks) is written in a single pass — the user dumps the whole
    // period at once, so there is exactly one block covering every working day.
    const isQuickFix = catchupSession.tierSelected === CatchupTier.QUICK_FIX;
    // Defensive clamp — rows written before the tier caps existed can hold any
    // number, and QUICK_FIX multiplies this straight into one OpenAI request.
    const maxCap = getMaxTierDuration(catchupSession.tierSelected);
    const safeDuration = Math.min(Math.max(1, catchupSession.totalDuration), maxCap);
    if (safeDuration !== catchupSession.totalDuration) {
      console.warn(
        `[catchup] Session ${sessionId} totalDuration=${catchupSession.totalDuration} clamped to ${safeDuration} (tier=${catchupSession.tierSelected})`,
      );
    }
    const totalBlocks = isQuickFix ? 1 : safeDuration;

    if (payload.fulfilledBlocks.includes(blockIndex)) {
      console.log(`[catchup] Block ${blockIndex} of session ${sessionId} already fulfilled — skipping.`);
      return;
    }

    if (blockIndex > totalBlocks) {
      console.log(`[catchup] Session ${sessionId} has no block ${blockIndex} (total ${totalBlocks}) — skipping.`);
      return;
    }

    // Atomic claim. Exactly one caller can move currentBlock off blockIndex, so
    // the webhook and the "I have paid" button cannot both start generating —
    // including across processes, which the old in-memory Set could not cover.
    // Claimed BEFORE the OpenAI call, since that is the whole race window.
    const claim = await prisma.catchupSession.updateMany({
      where: { id: sessionId, currentBlock: blockIndex },
      data: { currentBlock: blockIndex + 1 },
    });

    if (claim.count === 0) {
      console.log(`[catchup] Block ${blockIndex} of session ${sessionId} already claimed — skipping.`);
      return;
    }
    claimedBlock = blockIndex;

    const applyState = (patch: Partial<StoredCatchupState>, opts?: { clearSessionId?: boolean }) =>
      syncCatchupState(telegramId, patch, opts);

    const blockWorkingDays = isQuickFix
      ? safeDuration * WORKING_DAYS_PER_WEEK
      : WORKING_DAYS_PER_MONTH;
    // Week 1 was already written as the free preview — only top up the remainder.
    const previewLogs = blockIndex === 1 ? payload.week1Preview : [];
    const daysToGenerate = Math.max(0, blockWorkingDays - previewLogs.length);

    const blockEntries = payload.blocks.find((block) => block.block === blockIndex)?.entries
      ?? payload.blocks.flatMap((block) => block.entries);
    const rawDump = blockEntries.join("\n\n");
    const workplaceRole = catchupSession.user.workplaceRole?.trim() || "IT";

    // Nothing to write from. Now reachable because the sweep covers block 1, and
    // generating from an empty dump would invent a month out of thin air. Release
    // the claim and leave it: /catchup resumes paid sessions and will ask for the
    // dump. Deliberately silent, since the sweep runs on every boot.
    if (!rawDump.trim() && previewLogs.length === 0) {
      console.warn(`[catchup] Block ${blockIndex} of session ${sessionId} has no source text — releasing claim.`);
      await prisma.catchupSession.updateMany({
        where: { id: sessionId, currentBlock: blockIndex + 1 },
        data: { currentBlock: blockIndex },
      });
      claimedBlock = null;
      return;
    }

    // Block 1 is the one that follows the charge. This is the user's receipt:
    // sent standalone and deliberately NOT captured as `loadingMsg`, so the
    // cleanup in `finally` never touches it and it stays in their history.
    if (blockIndex === 1) {
      await notifyCatchupUser(telegramId, "Payment successful!");
    }

    const loadingMsg = await notifyCatchupUser(telegramId, LOADING_STEPS[0]);
    const stopLoading = loadingMsg
      ? startLoadingCycler(bot.api, Number(telegramId), loadingMsg.message_id)
      : () => {};

    let savedCount = 0;
    let isFinalBlock: boolean;
    let nextBlock: number;
    /**
     * The model returned nothing at all — a failure, NOT "those dates were
     * already taken". The two both end at savedCount === 0 but are opposite
     * situations: this one means we charged for a month we never wrote, so the
     * block must not be marked fulfilled.
     */
    let generationEmpty = false;

    try {
      const generated = daysToGenerate > 0
        ? (await generateCatchupLogs(rawDump, daysToGenerate, workplaceRole, daysToGenerate)).logs.slice(0, daysToGenerate)
        : [];

      // Map every log in this block onto a calendar date. Blocks are laid out
      // back-to-back in working days from the session's anchor date.
      const startDate = new Date(catchupSession.startDate);
      const blockOffset = (blockIndex - 1) * blockWorkingDays;

      const blockLogs = [
        ...previewLogs.map((log) => ({
          content: log.content,
          logDate: nthWorkingDayFrom(startDate, blockOffset + log.dateOffset),
        })),
        ...generated.map((log, index) => ({
          content: log.content,
          logDate: nthWorkingDayFrom(startDate, blockOffset + previewLogs.length + index),
        })),
      ];

      const insertData: Array<{ userId: number; content: string; isAiRefined: boolean; isVoice: boolean; logDate: Date }> = [];

      if (blockLogs.length > 0) {
        const sortedDates = blockLogs.map((log) => log.logDate).sort((a, b) => a.getTime() - b.getTime());
        // Cover the whole final day — logs saved through the normal flow carry a
        // wall-clock time, so `lte: <midnight>` silently missed them and we wrote
        // a second log for that date.
        const lastDayEnd = new Date(sortedDates[sortedDates.length - 1]);
        lastDayEnd.setUTCHours(23, 59, 59, 999);

        const existingLogs = await prisma.log.findMany({
          where: {
            userId: catchupSession.userId,
            logDate: { gte: sortedDates[0], lte: lastDayEnd },
          },
          select: { logDate: true },
        });

        const takenDates = new Set(existingLogs.map((log) => log.logDate.toISOString().split('T')[0]));

        for (const log of blockLogs) {
          const key = log.logDate.toISOString().split('T')[0];
          if (takenDates.has(key)) continue;
          takenDates.add(key);
          insertData.push({
            userId: catchupSession.userId,
            content: log.content,
            isAiRefined: true,
            isVoice: false,
            logDate: log.logDate,
          });
        }
      }

      isFinalBlock = blockIndex >= totalBlocks;
      nextBlock = isFinalBlock ? blockIndex : blockIndex + 1;

      generationEmpty = blockLogs.length === 0;

      // Logs and the fulfilment ledger commit together — a crash between them
      // used to leave the block written but unmarked, so a retry regenerated it
      // and reported "0 days saved".
      //
      // `user.logCount` is deliberately NOT incremented here. It meters the free
      // storage allowance, and these logs were paid for by the Rescue Pass —
      // charging them against the free ceiling locked users out of ordinary
      // logging the moment their catch-up landed.
      savedCount = generationEmpty ? 0 : await prisma.$transaction(async (tx) => {
        let created = 0;

        if (insertData.length > 0) {
          // skipDuplicates leans on @@unique([userId, logDate]); count the rows
          // actually written, never insertData.length.
          const result = await tx.log.createMany({ data: insertData, skipDuplicates: true });
          created = result.count;
        }

        await tx.catchupSession.update({
          where: { id: sessionId },
          data: {
            paymentStatus: CatchupPaymentStatus.PAID,
            contextDump: buildContextDump({
              ...payload,
              fulfilledBlocks: [...payload.fulfilledBlocks, blockIndex],
            }),
          },
        });

        return created;
      });
    } finally {
      stopLoading();
      if (loadingMsg) {
        await bot.api.deleteMessage(Number(telegramId), loadingMsg.message_id).catch(() => {});
      }
    }

    // The model gave us nothing to write. The block is deliberately NOT marked
    // fulfilled and the claim goes back, so the user keeps what they paid for and
    // the block can be retried once they add detail. Treated exactly like a
    // thrown generation error, because that is what it is.
    if (generationEmpty) {
      console.error(`[catchup] Block ${blockIndex} of session ${sessionId} generated 0 logs — not marking fulfilled.`);

      await prisma.catchupSession.updateMany({
        where: { id: sessionId, currentBlock: blockIndex + 1 },
        data: { currentBlock: blockIndex },
      });
      claimedBlock = null;

      await applyState({ active: true, step: 'awaiting_block_dump', startedAt: Date.now() });
      await notifyCatchupUser(
        telegramId,
        "Your payment went through, but I hit a snag writing those logs 😔\n\nNothing is lost. Send me a message and I'll pick it right back up.",
      );
      return;
    }

    console.log(`[catchup] Session ${sessionId} — block ${blockIndex}/${totalBlocks} fulfilled (${savedCount} logs saved)`);

    // Logs were generated, but every date already had one. The block IS done —
    // there is genuinely nothing left to write for it — so it stays fulfilled and
    // we say so plainly instead of claiming "All 0 days have been saved".
    const nothingNewSaved = savedCount === 0;

    if (!isFinalBlock) {
      // The block is written and committed, so the text that produced it is spent.
      // Clearing it here — BEFORE the next prompt goes out — is what stops a
      // restart mid-flow from feeding last month's dump into next month's block.
      await applyState({
        active: true,
        step: 'awaiting_block_dump',
        startedAt: Date.now(),
        rawDump: undefined,
        questionCount: undefined,
      });

      const monthStart = new Date(catchupSession.startDate);
      const blockSummary = nothingNewSaved
        ? ZERO_NEW_LOGS_MESSAGE
        : `*${getBlockMonthName(monthStart, blockIndex)}* is complete!\n\n` +
          `All ${savedCount} ${savedCount === 1 ? 'day has' : 'days have'} been safely saved to your calendar. ` +
          `You can view or copy them anytime.`;

      await notifyCatchupUser(
        telegramId,
        `${blockSummary}\n\n` +
          `Now, let's keep the momentum going. Tell me what you did for *${getBlockMonthName(monthStart, nextBlock)}*...\n\n` +
          `(Feel free to use a voice note)`,
        { parse_mode: "Markdown" },
      );
      return;
    }

    await applyState({ active: false, step: 'none', startedAt: undefined }, { clearSessionId: true });

    // Never claim the backlog is filled out when we added nothing to it.
    if (nothingNewSaved) {
      await notifyCatchupUser(
        telegramId,
        ZERO_NEW_LOGS_MESSAGE,
        { reply_markup: new InlineKeyboard().text("View my logs", "nav_logs") },
      );
    }

    // Fast-track users get the reminder bridge INSTEAD of the standard sign-off,
    // not after it — that message opens with its own "caught up" line, and its
    // "Write Today's Log" button would compete with the time picker. They still
    // get it when nothing was saved: the reminder setup is their onboarding.
    if (await isFastTrackUser(telegramId, ctx)) {
      await promptFastTrackReminderSetup(telegramId);
    } else if (!nothingNewSaved) {
      await notifyCatchupUser(
        telegramId,
        ALL_DONE_MESSAGE,
        { reply_markup: new InlineKeyboard().text("View my logs", "nav_logs") },
      );
    }

    if (catchupSession.tierSelected === CatchupTier.VIP_DEFENSE) {
      // TODO: Generate Final Report
    }
  } catch (err) {
    console.error(`[catchup] Fulfilment failed for session ${sessionId}:`, err);

    // Release the claim so the block can be retried. Guarded on the value we set,
    // so it is a no-op if the ledger already committed or another caller moved on.
    if (claimedBlock !== null) {
      try {
        await prisma.catchupSession.updateMany({
          where: { id: sessionId, currentBlock: claimedBlock + 1 },
          data: { currentBlock: claimedBlock },
        });
      } catch (releaseErr) {
        console.error(`[catchup] Failed to release block claim for session ${sessionId}:`, releaseErr);
      }
    }

    try {
      const owner = await prisma.catchupSession.findUnique({
        where: { id: sessionId },
        select: { user: { select: { telegramId: true } } },
      });
      if (owner) {
        // Never leave the session parked on 'generating' — that step has no
        // handler, so every message the user sent afterwards was swallowed.
        await syncCatchupState(owner.user.telegramId, {
          active: true,
          step: 'awaiting_block_dump',
          startedAt: Date.now(),
        });

        await notifyCatchupUser(
          owner.user.telegramId,
          "Your payment went through, but I hit a snag writing those logs 😔\n\nNothing is lost. Send me a message and I'll pick it right back up.",
        );
      }
    } catch {
      // best-effort notification only
    }
  }
}

// ----------------------------------------------------------------------------
// POST-CATCHUP BRIDGE (FAST TRACK)
// Deep-link users never went through onboarding: they have `onboardingDone:
// true`, a placeholder reminderTime, and no ReminderJob row at all. Once their
// backlog is written, this is where we owe them the reminder setup.
// ----------------------------------------------------------------------------

const FAST_TRACK_TIME_PREFIX = "ftrem_time_";
const FAST_TRACK_SKIP_DATA = "ftrem_skip";
/** Matches both branches of the fast-track reminder keyboard. */
export const FAST_TRACK_REMINDER_PATTERN = /^ftrem_(time_\d{2}:\d{2}|skip)$/;

/**
 * Reads the fast-track flag for a user who may not be the one driving the
 * current update.
 *
 * Completion is reached from the Paystack webhook (`src/index.ts`) and the
 * abandoned-block sweep with no `ctx` at all — and for QUICK_FIX, the webhook is
 * the *usual* path — so `ctx.session` cannot be the source of truth here.
 */
async function isFastTrackUser(telegramId: bigint, ctx?: BotContext): Promise<boolean> {
  if (ctx?.from && BigInt(ctx.from.id) === telegramId) {
    return ctx.session.isCatchupFastTrack === true;
  }

  try {
    const stored = await readStoredSession(telegramId.toString());
    return stored?.isCatchupFastTrack === true;
  } catch (err) {
    console.error(`[catchup] Could not read fast-track flag for ${telegramId}:`, err);
    return false; // fall back to the standard completion message
  }
}

/**
 * Offers the reminder setup a fast-track user never got during onboarding.
 * Takes a telegramId rather than a ctx because the caller often has no ctx.
 */
export async function promptFastTrackReminderSetup(telegramId: bigint): Promise<void> {
  // Link arrivals never see the standard sign-off, so this message carries the
  // same "logs are stored, here they are" payoff plus the same nav_logs button.
  const keyboard = buildTimeKeyboard(FAST_TRACK_TIME_PREFIX)
    .row()
    .text("View my logs", "nav_logs")
    .row()
    .text("Skip for now", FAST_TRACK_SKIP_DATA);

  await notifyCatchupUser(
    telegramId,
    "You're completely caught up. Your logs are safely stored.\n\n" +
      "To make sure you never have to do a massive backlog again, let's set up a quick daily reminder. " +
      "What time should I text you to ask for your daily log?",
    { reply_markup: keyboard },
  );
}

/**
 * Sends a message together with the persistent main menu keyboard.
 *
 * Doubles as the way out of the funnel: deep-link users never received this
 * keyboard during onboarding, so this is the first point at which they get one.
 */
async function sendMainMenuWithMessage(ctx: BotContext, text: string): Promise<void> {
  const user = await prisma.user.findUnique({
    where: { telegramId: BigInt(ctx.from!.id) },
    select: { id: true, firstName: true, isPro: true, storageUnlocked: true, logCount: true, nextRenewalDate: true },
  });

  await ctx.reply(text, { reply_markup: getMainMenuKeyboard(user ? hasActiveStorage(user) : false) });
}

/** Handles both the time picker and the Skip button on the fast-track prompt. */
export async function handleFastTrackReminderCallback(ctx: BotContext): Promise<void> {
  const data = ctx.callbackQuery?.data ?? "";
  await ctx.answerCallbackQuery();

  // Retire the keyboard either way, so the prompt cannot be answered twice.
  await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});

  // Cleared before the DB work: if that throws, the user still leaves the
  // express lane rather than being re-prompted on every future completion.
  ctx.session.isCatchupFastTrack = false;
  clearActiveFlow(ctx.session);

  if (data === FAST_TRACK_SKIP_DATA) {
    await sendMainMenuWithMessage(
      ctx,
      "No worries! You can always set one up later in the menu. Welcome to Wisa.",
    );
    return;
  }

  const reminderTime = data.replace(FAST_TRACK_TIME_PREFIX, "");
  const telegramId = BigInt(ctx.from!.id);

  try {
    const user = await prisma.user.update({
      where: { telegramId },
      data: { reminderTime },
    });

    // Same replace-then-recreate as the settings flow — a fast-track user should
    // have no jobs at all, but a stray one would otherwise double their pings.
    await prisma.reminderJob.deleteMany({
      where: { userId: user.id, status: { in: ["pending", "sent"] } },
    });
    await createInitialReminderJobs(user.id, telegramId, user.logFrequency, reminderTime, user.timezone);

    await sendMainMenuWithMessage(ctx, `Done! I'll ping you daily at ${reminderTime}. Welcome to Wisa.`);
  } catch (err) {
    console.error(`[catchup] Fast-track reminder setup failed for ${telegramId}:`, err);
    await sendMainMenuWithMessage(
      ctx,
      "I couldn't save that reminder time 😔 Your logs are safe. You can set one up any time from Settings.",
    );
  }
}

// ----------------------------------------------------------------------------
// DATE HELPERS
// Strictly UTC. date-fns `addDays`/`getDay` read the host's local calendar, so
// on a host west of UTC a midnight-UTC anchor resolved to the previous day and
// the weekend skip landed logs on Saturdays. Every log date produced here is
// midnight UTC, which is also what makes the (userId, logDate) unique index a
// real one-log-per-day guarantee for catch-up rows.
// ----------------------------------------------------------------------------

function addWorkingDays(date: Date, n: number): Date {
  const d = new Date(date);
  let counted = 0;
  while (counted < n) {
    d.setUTCDate(d.getUTCDate() + 1);
    const dow = d.getUTCDay();
    if (dow !== 0 && dow !== 6) counted++;
  }
  return d;
}

function nextWorkingDay(date: Date): Date {
  const d = new Date(date);
  d.setUTCDate(d.getUTCDate() + 1);
  while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  return d;
}

/**
 * Returns the nth working day (Mon–Fri) from startDate, normalised to midnight UTC.
 * n=0 returns startDate itself (or the next Monday if startDate is a weekend).
 * n=1 returns the next working day after the base; etc.
 */
export function nthWorkingDayFrom(startDate: Date, n: number): Date {
  const base = new Date(startDate);
  base.setUTCHours(0, 0, 0, 0);

  const dow = base.getUTCDay();
  if (dow === 6) base.setUTCDate(base.getUTCDate() + 2); // Sat → Mon
  else if (dow === 0) base.setUTCDate(base.getUTCDate() + 1); // Sun → Mon

  return addWorkingDays(base, n);
}

// ----------------------------------------------------------------------------
// START UP FLOW
// ----------------------------------------------------------------------------
/** True once the session's final block has been fulfilled. */
function isCatchupSessionComplete(session: {
  tierSelected: CatchupTier;
  totalDuration: number;
  contextDump: unknown;
}): boolean {
  const totalBlocks = getCatchupTotalBlocks(session.tierSelected, session.totalDuration);
  return readContextPayload(session.contextDump).fulfilledBlocks.some((block) => block >= totalBlocks);
}

/**
 * Finds a session the user has already paid for but not finished.
 *
 * Multi-month tiers need one brain dump per month, which almost never happens
 * inside a single 2-hour window. Before this, the expiry cleared the flow and
 * `/catchup` only ever reused a PENDING row, so the paid session became
 * unreachable and the user was quoted a second invoice.
 */
async function findIncompletePaidSession(userId: number) {
  const paidSessions = await prisma.catchupSession.findMany({
    where: { userId, paymentStatus: CatchupPaymentStatus.PAID },
    orderBy: { createdAt: "desc" },
    take: 5,
  });

  return paidSessions.find((session) => !isCatchupSessionComplete(session)) ?? null;
}

/**
 * Puts the user back into a paid session: generates straight away if the block
 * already has its dump, otherwise asks for the one that is missing.
 */
async function resumePaidCatchupSession(
  ctx: BotContext,
  session: Awaited<ReturnType<typeof findIncompletePaidSession>>,
): Promise<void> {
  if (!session) return;

  const blockIndex = Math.max(1, session.currentBlock);
  const payload = readContextPayload(session.contextDump);
  const hasDumpForBlock = Boolean(
    payload.blocks.find((block) => block.block === blockIndex)?.entries.length,
  );

  ctx.session.catchupSessionId = session.id;
  ctx.session.catchup = {
    active: true,
    step: hasDumpForBlock ? 'generating' : 'awaiting_block_dump',
    startedAt: Date.now(),
  };

  await ctx.reply("You've already paid for this rescue, picking up right where we left off.");

  if (hasDumpForBlock) {
    await resumeCatchupGeneration(session.id, ctx);
    return;
  }

  const monthStart = new Date(session.startDate);
  await ctx.reply(
    `Tell me what you did for *${getBlockMonthName(monthStart, blockIndex)}*...\n\n` +
      `(Feel free to use a voice note)`,
    { parse_mode: "Markdown" },
  );
}

/** The tier keyboard. Extracted so the deep-link funnel can reach it after the
 *  role question without the copy being duplicated. */
/** Single source for the tier copy, so Back can re-render it identically. */
const CATCHUP_TIER_PROMPT =
  "Got some empty days in your logbook?\n\n" +
  "No worries. Just tell me a bit about what you've been doing at work lately, and I'll handle writing the actual logs for you. How many weeks or months are you missing?";

/** Single source for the duration copy, for the same reason. */
function catchupDurationPrompt(tier: CatchupTier): string {
  return `Got it. How many ${getCatchupTierUnit(tier)} are you missing?`;
}

async function sendCatchupTierPrompt(ctx: BotContext): Promise<void> {
  ctx.session.catchup = {
    active: true,
    step: 'awaiting_tier_selection',
    startedAt: Date.now(),
  };

  await ctx.reply(
    CATCHUP_TIER_PROMPT,
    { parse_mode: "Markdown", reply_markup: generateCatchupTierKeyboard() }
  );
}

export async function startCatchupFlow(ctx: BotContext) {
  clearActiveFlow(ctx.session);

  // A paid, unfinished session outranks starting a new one — otherwise the user
  // is sold a second Rescue Pass for months they already own.
  const dbUser = await prisma.user.findUnique({
    where: { telegramId: BigInt(ctx.from!.id) },
    select: { id: true, workplaceRole: true },
  });

  if (dbUser) {
    const outstanding = await findIncompletePaidSession(dbUser.id);
    if (outstanding) return resumePaidCatchupSession(ctx, outstanding);

    // Deep-link arrivals land here with no role on file. Ask BEFORE the tiers so
    // the broadcast funnel never shows a price to someone whose logs we cannot
    // write accurately, and so the role is on file for the very first block.
    if (!dbUser.workplaceRole?.trim()) {
      // Signals "asked pre-tier" to the awaiting_course handler: a mid-flow
      // interceptor always runs with a live session id, this path never does.
      ctx.session.catchupSessionId = undefined;
      ctx.session.catchup = {
        active: true,
        step: 'awaiting_course',
        startedAt: Date.now(),
      };

      await ctx.reply(WORKPLACE_ROLE_QUESTION);
      return;
    }
  }

  await sendCatchupTierPrompt(ctx);
}

/**
 * Records the chosen duration and moves the user on to the date picker.
 * Shared by the duration keyboard and the typed-number fallback.
 */
async function applyCatchupDuration(
  ctx: BotContext,
  sessionId: string,
  duration: number,
  startedAt?: number,
): Promise<void> {
  await prisma.catchupSession.update({
    where: { id: sessionId },
    data: { totalDuration: duration },
  });

  ctx.session.catchup = {
    active: true,
    step: 'awaiting_anchor_date',
    startedAt: startedAt ?? Date.now(),
  };

  const now = new Date();
  await ctx.reply("What exact date did this start?", {
    reply_markup: generateCatchupCalendar(now.getFullYear(), now.getMonth(), 'start'),
  });
}

// ----------------------------------------------------------------------------
// CALLBACK HANDLER (Handles Calendar Taps)
// ----------------------------------------------------------------------------
/**
 * Error boundary for every catch-up callback.
 *
 * Without this, a Prisma or Telegram failure mid-handler escaped to bot.catch
 * with the callback query still unanswered, so the button span until Telegram
 * timed it out and the user was told nothing.
 */
export async function handleCatchupCallback(ctx: BotContext) {
  try {
    await routeCatchupCallback(ctx);
  } catch (err) {
    console.error("[catchup] Callback handler failed:", err);
    // Best-effort: answering twice throws, so swallow. The reply is what the
    // user actually sees either way.
    await ctx.answerCallbackQuery().catch(() => {});
    await ctx
      .reply(
        "Something went wrong on our end 😔\n\nYour dates and notes are still saved. Type /catchup to try again. You won't have to start over.",
      )
      .catch(() => {});
  }
}

async function routeCatchupCallback(ctx: BotContext) {
  const data = ctx.callbackQuery?.data;
  if (!data) return;
  const state = ctx.session.catchup;

  if (data.startsWith("catchup_tier_")) {
    const tier = data.replace("catchup_tier_", "");
    // Also the backstop for a retired tier: an old keyboard still sitting in a
    // chat can replay `catchup_tier_VIP_DEFENSE`, and it must not open a session.
    if (!SELECTABLE_CATCHUP_TIERS.includes(tier as typeof SELECTABLE_CATCHUP_TIERS[number])) {
      await ctx.answerCallbackQuery("That option isn't available anymore. Please pick one below.");
      return;
    }

    const telegramId = BigInt(ctx.from!.id);
    const dbUser = await prisma.user.findUnique({ where: { telegramId }, select: { id: true } });
    if (!dbUser) {
      await ctx.answerCallbackQuery("Couldn't find your account. Please type /start.");
      return;
    }

    const tierSelected = CatchupTier[tier as keyof typeof CatchupTier];

    // Answered BEFORE the writes below. Everything past this point can fail, and
    // a spinning button with no explanation is worse than an error message.
    await ctx.answerCallbackQuery();

    // Reuse the open session rather than creating one per tap — tapping through
    // the tier keyboard used to leave a trail of half-built PENDING rows, and
    // getCatchupSessionForCurrentUser falls back to "most recent", so an
    // abandoned one could later be picked up mid-flow.
    const existingSession = await prisma.catchupSession.findFirst({
      where: { userId: dbUser.id, paymentStatus: CatchupPaymentStatus.PENDING },
      orderBy: { createdAt: 'desc' },
    });

    const freshSessionState = {
      tierSelected,
      totalDuration: 0,
      currentBlock: 1,
      startDate: new Date(),
      paymentStatus: CatchupPaymentStatus.PENDING,
    };

    const catchupSession = existingSession
      ? await prisma.catchupSession.update({
          where: { id: existingSession.id },
          // Everything resets: the user is starting over, so a stale brain dump
          // from the abandoned attempt must not leak into the new one.
          data: { ...freshSessionState, contextDump: Prisma.DbNull },
        })
      : await prisma.catchupSession.create({
          data: { userId: dbUser.id, ...freshSessionState },
        });

    ctx.session.catchupSessionId = catchupSession.id;
    ctx.session.catchup = {
      active: true,
      step: 'awaiting_duration',
      startedAt: Date.now(),
    };

    await ctx.editMessageText(
      catchupDurationPrompt(tierSelected),
      { reply_markup: generateCatchupDurationKeyboard(tierSelected) },
    ).catch(() => {});
    return;
  }

  // Duration is tapped, not typed. The text handler still accepts a number as a
  // fallback for anyone who types anyway.
  if (data.startsWith("cdur_")) {
    if (!state?.active) {
      await ctx.answerCallbackQuery("This flow has expired. Please type /catchup again.");
      return;
    }

    const catchupSession = await getCatchupSessionForCurrentUser(ctx);
    if (!catchupSession) {
      await ctx.answerCallbackQuery("Couldn't find this catch-up session. Please type /catchup again.");
      return;
    }

    const duration = Number(data.replace("cdur_", ""));
    if (!getCatchupDurationOptions(catchupSession.tierSelected).includes(duration)) {
      await ctx.answerCallbackQuery("That option isn't available on this plan. Please pick one below.");
      return;
    }

    // Answered before the write, for the same reason as the tier handler above.
    await ctx.answerCallbackQuery();
    // Retire this picker before the calendar is sent. Otherwise both keyboards
    // stay live and Back from the calendar leaves two duration pickers on screen.
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    await applyCatchupDuration(ctx, catchupSession.id, duration, state.startedAt);
    return;
  }

  // Back: duration picker -> tier keyboard.
  if (data === "catchup_back_tier") {
    await ctx.answerCallbackQuery();

    ctx.session.catchup = {
      active: true,
      step: 'awaiting_tier_selection',
      startedAt: state?.startedAt ?? Date.now(),
    };

    await ctx.editMessageText(CATCHUP_TIER_PROMPT, {
      parse_mode: "Markdown",
      reply_markup: generateCatchupTierKeyboard(),
    }).catch(() => {});
    return;
  }

  // Back: date picker -> duration picker. Needs the tier to rebuild the options.
  if (data === "catchup_back_duration") {
    const catchupSession = await getCatchupSessionForCurrentUser(ctx);
    if (!catchupSession) {
      await ctx.answerCallbackQuery("Couldn't find this catch-up session. Please type /catchup again.");
      return;
    }

    await ctx.answerCallbackQuery();

    ctx.session.catchup = {
      active: true,
      step: 'awaiting_duration',
      startedAt: state?.startedAt ?? Date.now(),
    };

    await ctx.editMessageText(catchupDurationPrompt(catchupSession.tierSelected), {
      reply_markup: generateCatchupDurationKeyboard(catchupSession.tierSelected),
    }).catch(() => {});
    return;
  }

  if (data === "ccal_noop") {
    await ctx.answerCallbackQuery();
    return;
  }

  if (data === "ccal_cancel") {
    clearActiveFlow(ctx.session);
    await ctx.editMessageText("Catch-up cancelled. Let me know when you're ready.", {
      reply_markup: new InlineKeyboard().text("Menu", "nav_menu")
    });
    await ctx.answerCallbackQuery();
    return;
  }

  if (data === "catchup_more_detail") {
    if (!state?.active) {
      await ctx.answerCallbackQuery("This flow has expired. Please type /catchup again.");
      return;
    }
    state.step = 'awaiting_more_detail';
    ctx.session.catchup = state;
    await ctx.editMessageText(
      "Tell me more about what you were doing during the rest of that period. Rough notes are fine."
    );
    await ctx.answerCallbackQuery();
    return;
  }

  // The way out of the funnel, from the tier keyboard or the week-1 paywall.
  // Handled ABOVE the `state.active` guard on purpose: a stale keyboard left in
  // the chat must still be able to close the flow rather than report an error.
  if (data === "catchup_exit") {
    clearActiveFlow(ctx.session);
    await ctx.answerCallbackQuery();
    // Retire the keyboard so the paywall cannot be re-tapped from history.
    await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => {});
    await sendMainMenuWithMessage(ctx, "No problem! You can always catch up later.");
    return;
  }

  if (data === "catchup_skip") {
    clearActiveFlow(ctx.session);
    await ctx.editMessageText(
      "No problem, the logs I generated are already in your logbook.",
      { reply_markup: new InlineKeyboard().text("View calendar", "nav_calendar").text("Menu", "nav_menu") }
    );
    await ctx.answerCallbackQuery();
    return;
  }

  if (data === "catchup_approve_wk1") {
    const catchupSession = await getCatchupSessionForCurrentUser(ctx);
    if (!catchupSession) {
      await ctx.answerCallbackQuery("This session could not be found. Please type /catchup again.");
      return;
    }

    await ctx.answerCallbackQuery();

    if (catchupSession.paymentStatus === CatchupPaymentStatus.PAID) {
      await ctx.reply("You've already paid for this rescue, picking up right where we left off.");
      await resumeCatchupGeneration(catchupSession.id, ctx);
      return;
    }

    await startRescuePassCheckout(ctx, catchupSession);
    return;
  }

  if (data === "catchup_tweak_wk1") {
    // Without this the step stays 'ready_for_week_1_generation', so the tweak text
    // is discarded and week 1 is simply regenerated from the unchanged dump.
    ctx.session.catchup = {
      ...(state ?? {}),
      active: true,
      step: 'awaiting_more_detail',
      startedAt: state?.startedAt ?? Date.now(),
    };

    await ctx.answerCallbackQuery();
    await ctx.reply("Send the missing details for Week 1, and I’ll tighten it up before you approve the rest.");
    return;
  }

  if (!state || !state.active) {
    await ctx.answerCallbackQuery("This flow has expired. Please type /catchup again.");
    return;
  }

  if (data.startsWith("ccal_sel_start_") && state.step === 'awaiting_anchor_date') {
    const match = data.match(/^ccal_sel_start_(\d{4}-\d{2}-\d{2})$/);
    if (!match) {
      await ctx.answerCallbackQuery("Invalid date selection. Please try again.");
      return;
    }

    const selectedDate = match[1];
    const catchupSession = await getCatchupSessionForCurrentUser(ctx);
    if (!catchupSession) {
      await ctx.answerCallbackQuery("Couldn't find this catch-up session. Please type /catchup again.");
      return;
    }

    await prisma.catchupSession.update({
      where: { id: catchupSession.id },
      data: {
        startDate: new Date(selectedDate),
      },
    });

    const userWorkplaceRole = (await prisma.user.findUnique({
      where: { id: catchupSession.userId },
      select: { workplaceRole: true },
    }))?.workplaceRole;

    if (!userWorkplaceRole) {
      ctx.session.catchup = {
        active: true,
        step: 'awaiting_course',
        startedAt: state.startedAt ?? Date.now(),
      };

      await ctx.editMessageText(WORKPLACE_ROLE_QUESTION).catch(() => {});
      await ctx.answerCallbackQuery();
      return;
    }

    ctx.session.catchup = {
      active: true,
      step: 'awaiting_block_dump',
      startedAt: state.startedAt ?? Date.now(),
    };

    // The row was just updated above, so read the month off the date we wrote.
    const anchorDate = new Date(selectedDate);
    const dumpPrompt = buildCatchupDumpPrompt(
      "Perfect. Tell me",
      catchupSession.tierSelected === CatchupTier.QUICK_FIX
        ? `this entire ${catchupSession.totalDuration}-week period`
        : `*${getBlockMonthName(anchorDate, catchupSession.currentBlock)}*`,
    );

    await ctx.editMessageText(dumpPrompt, { parse_mode: "Markdown" }).catch(() => {});
    await ctx.answerCallbackQuery();
    return;
  }

  // Handle Month Navigation
  if (data.startsWith("ccal_nav_")) {
    const parts = data.split("_");
    const mode = parts[2] as 'start' | 'end';
    const year = parseInt(parts[3]);
    const month = parseInt(parts[4]);

    const kb = generateCatchupCalendar(year, month, mode);
    await ctx.editMessageReplyMarkup({ reply_markup: kb }).catch(() => {});
    await ctx.answerCallbackQuery();
    return;
  }

  // Handle Date Selection
  if (data.startsWith("ccal_sel_")) {
    await ctx.answerCallbackQuery();
  }
}

// ----------------------------------------------------------------------------
// TEXT HANDLER (Handles the Brain-dump text and Gatekeeper)
// ----------------------------------------------------------------------------

/**
 * Core text-processing logic for the catch-up flow.
 * Exported separately so voice transcriptions can be fed in directly without
 * going through ctx.message.text.
 */
export async function handleCatchupFlowWithText(ctx: BotContext, text: string): Promise<void> {
  const state = ctx.session.catchup;

  if (!text || !state) return;

  const CATCHUP_TIMEOUT_MS = 2 * 60 * 60 * 1000;
  if (state.startedAt && Date.now() - state.startedAt > CATCHUP_TIMEOUT_MS) {
    // Never expire work the user has already paid for. A six-month backlog is
    // one dump per month; expiring it stranded the paid session and quoted them
    // a second invoice. Unpaid sessions still time out exactly as before.
    const openSession = await getCatchupSessionForCurrentUser(ctx);
    const paidWorkOutstanding =
      openSession?.paymentStatus === CatchupPaymentStatus.PAID && !isCatchupSessionComplete(openSession);

    if (!paidWorkOutstanding) {
      clearActiveFlow(ctx.session);
      await ctx.reply(
        "Your catch-up session expired after 2 hours of inactivity. Type /catchup to start a new one."
      );
      return;
    }

    // Roll the window forward so the next gap is measured from now.
    state.startedAt = Date.now();
    ctx.session.catchup = state;
  }

  if (text.toLowerCase() === 'cancel' || text === '/cancel') {
    clearActiveFlow(ctx.session);
    await ctx.reply("Catch-up cancelled. Let me know when you're ready.", {
      reply_markup: new InlineKeyboard().text("Menu", "nav_menu")
    });
    return;
  }

  if (/^[^a-zA-Z0-9]*(catch up|fill missed days|catch up missed days)[^a-zA-Z0-9]*$/i.test(text)) {
    return startCatchupFlow(ctx);
  }

  const telegramId = BigInt(ctx.from!.id);

  try {
    switch (state.step) {
      // Duration is normally tapped from the keyboard. This stays as a fallback
      // for anyone who types a number anyway, so their answer is not swallowed.
      case 'awaiting_duration': {
        // Fetched first, since the valid range depends on the tier they picked.
        const catchupSession = await getCatchupSessionForCurrentUser(ctx);
        if (!catchupSession) {
          await ctx.reply("I couldn't find this catch-up session. Please type /catchup again.");
          return;
        }

        const options = getCatchupDurationOptions(catchupSession.tierSelected);
        const unit = getCatchupTierUnit(catchupSession.tierSelected);
        const duration = parseInt(text.trim(), 10);

        if (!Number.isFinite(duration) || !options.includes(duration)) {
          await ctx.reply(
            `This plan covers ${options[0]} to ${options[options.length - 1]} ${unit}.\n\n` +
              "Tap one of the options above, or type /catchup to pick a different plan.",
          );
          return;
        }

        await applyCatchupDuration(ctx, catchupSession.id, duration, state.startedAt);
        return;
      }

      case 'awaiting_block_dump': {
        const appended = await appendCatchupDumpToSession(ctx, text);
        if (!appended) {
          await ctx.reply("I couldn't find this catch-up session. Please type /catchup again.");
          return;
        }

        await evaluateCurrentCatchupChunk(ctx, appended.currentEntries.join("\n\n"));
        return;
      }

      // The preview has already been sent by the time the user can type here.
      // Re-running it billed another OpenAI call and posted a second set of five
      // logs plus a duplicate paywall, so stray text only gets a nudge now.
      case 'ready_for_week_1_generation': {
        await ctx.reply("Please tap 'Approve and continue' or 'Tweak' below to proceed!");
        return;
      }

      case 'awaiting_payment_email': {
        const email = text.trim().toLowerCase();
        if (!isValidEmail(email)) {
          await ctx.reply("That email looks invalid. Please send a valid email address.");
          return;
        }

        await prisma.user.update({ where: { telegramId }, data: { paymentEmail: email } });

        const catchupSession = await getCatchupSessionForCurrentUser(ctx);
        if (!catchupSession) {
          await ctx.reply("I couldn't find this catch-up session. Please type /catchup again.");
          return;
        }

        await ctx.reply(`Saved! Generating your secure payment link, one sec...`);

        try {
          await sendRescuePassInvoice(ctx, catchupSession, email);
        } catch (err) {
          console.error("[catchup] initializeCatchupPassTransaction after email capture failed:", err);
          await ctx.reply("I couldn't generate a payment link right now. Please try again in a moment.");
        }
        return;
      }

      case 'awaiting_payment': {
        await ctx.reply(
          "I'm still waiting on that payment. Tap *I have paid* on the invoice above once it's done, or send /cancel to stop.",
          { parse_mode: "Markdown" },
        );
        return;
      }

      // Captures the user's workplace ROLE, not an academic course. It is stored
      // on `User.workplaceRole`; the column name is legacy.
      case 'awaiting_course': {
        const roleText = text.trim();

        // Stays on this step so a greeting cannot become their job role.
        if (!isPlausibleWorkplaceRole(roleText)) {
          await ctx.reply(INVALID_ROLE_REPLY);
          return;
        }

        if (roleText.length > 100) {
          await ctx.reply("That's a bit long. Please keep your job role under 100 characters.");
          return;
        }

        await prisma.user.update({
          where: { telegramId },
          data: { workplaceRole: roleText },
        });

        // Asked BEFORE the tiers (deep-link funnel): there is no session yet, so
        // hand them straight to the tier keyboard rather than a dump prompt for
        // a period they have not chosen.
        if (!ctx.session.catchupSessionId) {
          await sendCatchupTierPrompt(ctx);
          return;
        }

        ctx.session.catchup = {
          active: true,
          step: 'awaiting_block_dump',
          startedAt: state.startedAt ?? Date.now(),
        };

        const courseCatchupSession = await getCatchupSessionForCurrentUser(ctx);
        const coursePeriod = courseCatchupSession?.tierSelected === CatchupTier.QUICK_FIX
          ? `this entire ${courseCatchupSession.totalDuration}-week period`
          : `*${
              courseCatchupSession
                ? getBlockMonthName(new Date(courseCatchupSession.startDate), courseCatchupSession.currentBlock)
                : "that month"
            }*`;

        await ctx.reply(
          buildCatchupDumpPrompt("Got it! Now, tell me", coursePeriod),
          { parse_mode: "Markdown" },
        );
        return;
      }

      case 'awaiting_more_detail': {
        const appended = await appendCatchupDumpToSession(ctx, text);
        if (!appended) {
          await ctx.reply("I couldn't find this catch-up session. Please type /catchup again.");
          return;
        }

        await evaluateCurrentCatchupChunk(ctx, appended.currentEntries.join("\n\n"), { afterMoreDetail: true });
        return;
      }

      // Generation runs for MINUTES on a full block, so a paying user sending a
      // message here is routine, not an error. This used to fall through to
      // `default`, which told them the bot had lost track and then called
      // clearActiveFlow — wiping the flow of someone mid-purchase.
      case 'generating': {
        const generatingSession = await getCatchupSessionForCurrentUser(ctx);

        // Still working. Reassure and leave the state completely untouched.
        if (generatingSession && !isCatchupSessionComplete(generatingSession)) {
          await ctx.reply(STILL_GENERATING_MESSAGE);
          return;
        }

        // The work is already finished, so this step was left behind by one of
        // resumeCatchupGeneration's early returns (block already fulfilled, or
        // claimed by the webhook). Close it out instead of stranding them on a
        // step with nothing to do.
        clearActiveFlow(ctx.session);
        await ctx.reply(
          ALL_DONE_MESSAGE,
          { reply_markup: new InlineKeyboard().text("View my logs", "nav_logs") },
        );
        return;
      }

      case 'awaiting_start_date':
      case 'awaiting_end_date':
      case 'awaiting_tier_selection':
      case 'awaiting_anchor_date': {
        // Was a silent delete. Bots CAN delete incoming messages in private
        // chats, so the user watched their own text vanish and got no reply —
        // and at the tier step they have no other exit. Nudge instead, and keep
        // the state active so they are not booted out of the flow.
        await ctx.reply("Please tap one of the buttons above, or type /cancel to exit.");
        return;
      }

      // Escape hatch: any step with no handler (e.g. 'generating' after a failed
      // fulfilment) would otherwise swallow every message and brick the session.
      default: {
        await ctx.reply(
          "I lost track of where we were in your catch-up 😅 Type /catchup to pick it back up.",
          { reply_markup: new InlineKeyboard().text("Menu", "nav_menu") },
        );
        clearActiveFlow(ctx.session);
        return;
      }
    }
  } catch (error) {
    console.error("Error in catchup flow:", error);
    if (ctx.session.catchup) ctx.session.catchup.active = false;
    await ctx.reply(
      "Something went wrong on our end 😔\n\nYour dates and notes are still saved. Type /catchup to try again. You won't have to start over."
    );
  }
}

export async function handleCatchupFlow(ctx: BotContext): Promise<void> {
  const text = ctx.message?.text?.trim();
  const state = ctx.session.catchup;
  if (!text || !state) return;
  await handleCatchupFlowWithText(ctx, text);
}