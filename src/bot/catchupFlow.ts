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
import { patchStoredSessionCatchup } from "./sessionStorage";
// NOTE: `bot` is only ever touched inside function bodies — the import cycle with
// ./index resolves lazily under CommonJS, so it is safe.
import { bot } from "./index";

// ----------------------------------------------------------------------------
// LOADING STATES
// One message that walks through the steps below every 5s, so a long generation
// never looks frozen. The timer clears itself at the final step, so it cannot
// leak even if the returned stopper is never called.
// ----------------------------------------------------------------------------

const LOADING_STEPS = ["Analyzing... ", "Generating your logs... ", "Almost done... "];

export function startLoadingCycler(api: any, chatId: number | string, messageId: number) {
  let step = 1;
  const timer = setInterval(() => {
    if (step >= LOADING_STEPS.length) {
      clearInterval(timer);
      return;
    }

    const current = step++;
    try {
      // Promise.resolve guards a non-thenable return; the try/catch guards a
      // synchronous throw. Either would escape the timer callback as an
      // uncaughtException and leave this interval running until its self-clear.
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
  const title = `${format(date, 'MMMM yyyy')} - ${mode === 'start' ? '🟢 Start Date' : '🔴 End Date'}`;
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

  kb.text("◀️ Prev", `ccal_nav_${mode}_${prevYear}_${prevMonth}`);
  kb.text("❌ Cancel", "ccal_cancel");
  kb.text("Next ▶️", `ccal_nav_${mode}_${nextYear}_${nextMonth}`);

  return kb;
}

function generateCatchupTierKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("📅 A Few Weeks (Max 4)", "catchup_tier_QUICK_FIX")
    .row()
    .text("🚨 2-6 Months", "catchup_tier_FULL_BACKLOG")
    .row()
    .text("👑 VIP + Final Report", "catchup_tier_VIP_DEFENSE");
}

function getCatchupTierUnit(tier: string): "weeks" | "months" {
  return tier === "QUICK_FIX" ? "weeks" : "months";
}

/**
 * Hard ceiling on totalDuration per tier — weeks for QUICK_FIX, months otherwise.
 * QUICK_FIX feeds `totalDuration * 5` days into a single OpenAI request, so an
 * unbounded value here turns into an unbounded completion.
 */
const MAX_TIER_DURATION: Record<CatchupTier, number> = {
  [CatchupTier.QUICK_FIX]: 4,
  [CatchupTier.FULL_BACKLOG]: 6,
  [CatchupTier.VIP_DEFENSE]: 6,
};

function getMaxTierDuration(tier: CatchupTier): number {
  return MAX_TIER_DURATION[tier] ?? 4;
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
  week1Preview?: Array<{
    dateOffset: number;
    task: string;
    weeklySummary: string;
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

  return { catchupSession, blocks, currentBlockIndex };
}

async function evaluateCurrentCatchupChunk(ctx: BotContext, rawText: string, opts?: { afterMoreDetail?: boolean }): Promise<void> {
  const catchupSession = await getCatchupSessionForCurrentUser(ctx);
  if (!catchupSession) {
    await ctx.reply("I couldn't find this catch-up session. Please type /catchup again.");
    return;
  }

  const user = await prisma.user.findUnique({
    where: { id: catchupSession.userId },
    select: { courseOfStudy: true },
  });
  const courseOfStudy = user?.courseOfStudy?.trim() ?? "";

  if (!courseOfStudy) {
    ctx.session.catchup = {
      active: true,
      step: 'awaiting_course',
      startedAt: ctx.session.catchup?.startedAt ?? Date.now(),
    };

    await ctx.reply("Wait, before we generate anything, what is your exact course of study and department?");
    return;
  }

  const evaluation = await evaluateCatchupDump(
    rawText,
    catchupSession.tierSelected,
    catchupSession.totalDuration,
    courseOfStudy,
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

    await ctx.reply("Perfect, that's solid detail. Writing these up now — give me a moment ✍️");
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

function getCatchupTierPrice(tier: CatchupTier): number {
  switch (tier) {
    case CatchupTier.QUICK_FIX:
      return 1000;
    case CatchupTier.FULL_BACKLOG:
      return 2500;
    case CatchupTier.VIP_DEFENSE:
      return 4000;
    default:
      return 1000;
  }
}

function formatWeekOneLog(log: {
  dateOffset: number;
  task: string;
  weeklySummary: string;
  content: string;
}, date: Date, dayNumber: number): string {
  const dateLabel = format(date, "EEE, d MMM yyyy");
  return [
    `*Day ${dayNumber}* • ${dateLabel}`,
    `Task: ${log.task}`,
    `Weekly Summary: ${log.weeklySummary}`,
  ].join("\n");
}

async function sendWeekOneBait(ctx: BotContext): Promise<void> {
  const catchupSession = await getCatchupSessionForCurrentUser(ctx);
  if (!catchupSession) {
    await ctx.reply("I couldn't find this catch-up session. Please type /catchup again.");
    return;
  }

  const user = await prisma.user.findUnique({
    where: { id: catchupSession.userId },
    select: { courseOfStudy: true },
  });
  const courseOfStudy = user?.courseOfStudy?.trim() || "IT";

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
      courseOfStudy,
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

    await ctx.reply(formattedLog, { parse_mode: "Markdown" });
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
    "Week 1 is locked in and perfectly formatted! ✅",
    {
      reply_markup: new InlineKeyboard()
        .text("💳 Approve & Unlock the Rest", "catchup_approve_wk1")
        .text("🔄 Tweak Week 1", "catchup_tweak_wk1"),
    },
  );
}

// ----------------------------------------------------------------------------
// RESCUE PASS — INVOICE
// ----------------------------------------------------------------------------

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

type CatchupSessionLike = { id: string; userId: number; tierSelected: CatchupTier };

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
  const amountKobo = priceNaira * 100;

  const reusable = await findReusablePendingInvoice(catchupSession);
  let authorization_url: string;
  let reference: string;

  if (reusable) {
    ({ authorization_url, reference } = reusable);
    console.log(`[catchup] Reusing pending Rescue Pass invoice ${reference} for session ${catchupSession.id}`);
  } else {
    ({ authorization_url, reference } = await initializeCatchupPassTransaction(
      email,
      amountKobo,
      catchupSession.id,
    ));

    await prisma.paymentTransaction.create({
      data: {
        userId: catchupSession.userId,
        amount: amountKobo,
        currency: "NGN",
        provider: "paystack",
        reference,
        metadata: {
          payment_type: RESCUE_PASS_PAYMENT_TYPE,
          catchup_session_id: catchupSession.id,
          tier: catchupSession.tierSelected,
          // Needed to re-send this exact link instead of minting another charge.
          authorization_url,
        },
        // status defaults to PENDING; paidAt stays null until the charge lands.
      },
    });
  }

  ctx.session.pendingPaystackRef = reference;
  ctx.session.catchup = {
    active: true,
    step: 'awaiting_payment',
    startedAt: ctx.session.catchup?.startedAt ?? Date.now(),
  };

  await ctx.reply(
    `Your Rescue Pass is ₦${priceNaira.toLocaleString("en-NG")} — that unlocks every remaining day of your logbook. 💳\n\n` +
      `Reference: \`${reference}\`\n\n` +
      `Once you've paid, tap *I have paid* and I'll start writing immediately.`,
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard()
        .url("💳 Pay with Paystack", authorization_url)
        .row()
        .text("🔄 I have paid", "check_payment"),
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

    await ctx.reply("Almost there — what email should I send the receipt to?");
    return;
  }

  await ctx.reply("Generating your secure payment link, one sec...⏳");

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
const BLOCK_CLAIM_LEASE_MS = 15 * 60 * 1000;

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
    const stale = await prisma.catchupSession.findMany({
      where: {
        paymentStatus: CatchupPaymentStatus.PAID,
        currentBlock: { gt: 1 },
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
      include: { user: { select: { id: true, telegramId: true, courseOfStudy: true } } },
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
    const courseOfStudy = catchupSession.user.courseOfStudy?.trim() || "IT";

    // Block 1 is the one the user just paid for; later blocks are triggered by
    // their own brain-dump, so don't re-announce the payment. This one stays on
    // screen — the cycler gets its own throwaway message below.
    await notifyCatchupUser(
      telegramId,
      blockIndex === 1 ? "Payment confirmed ✅" : `Writing Month ${blockIndex} now...`,
    );

    const loadingMsg = await notifyCatchupUser(telegramId, LOADING_STEPS[0]);
    const stopLoading = loadingMsg
      ? startLoadingCycler(bot.api, Number(telegramId), loadingMsg.message_id)
      : () => {};

    let savedCount = 0;
    let isFinalBlock: boolean;
    let nextBlock: number;

    try {
      const generated = daysToGenerate > 0
        ? (await generateCatchupLogs(rawDump, daysToGenerate, courseOfStudy, daysToGenerate)).logs.slice(0, daysToGenerate)
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

      // Logs and the fulfilment ledger commit together — a crash between them
      // used to leave the block written but unmarked, so a retry regenerated it
      // and reported "0 days saved".
      //
      // `user.logCount` is deliberately NOT incremented here. It meters the free
      // storage allowance, and these logs were paid for by the Rescue Pass —
      // charging them against the free ceiling locked users out of ordinary
      // logging the moment their catch-up landed.
      savedCount = await prisma.$transaction(async (tx) => {
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

    console.log(`[catchup] Session ${sessionId} — block ${blockIndex}/${totalBlocks} fulfilled (${savedCount} logs saved)`);

    if (!isFinalBlock) {
      await applyState({ active: true, step: 'awaiting_block_dump', startedAt: Date.now() });
      await notifyCatchupUser(
        telegramId,
        `Month ${blockIndex} complete! ✅ ${savedCount} day${savedCount === 1 ? '' : 's'} saved to your logbook.\n\n` +
          `Now, tell me what you did for Month ${nextBlock}...\n\n` +
          `*(Feel free to use a voice note 🎙️)*`,
        { parse_mode: "Markdown" },
      );
      return;
    }

    await applyState({ active: false, step: 'none', startedAt: undefined }, { clearSessionId: true });

    await notifyCatchupUser(
      telegramId,
      "All logs generated successfully and saved to your logbook! 🎉",
      { reply_markup: new InlineKeyboard().text("📅 View calendar", "nav_calendar").text("🏠 Menu", "nav_menu") },
    );

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
          "Your payment went through, but I hit a snag writing those logs 😔\n\nNothing is lost — send me a message and I'll pick it right back up.",
        );
      }
    } catch {
      // best-effort notification only
    }
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
export async function startCatchupFlow(ctx: BotContext) {
  clearActiveFlow(ctx.session);

  ctx.session.catchup = {
    active: true,
    step: 'awaiting_tier_selection',
    startedAt: Date.now(),
  };

  await ctx.reply(
    "How far behind is this logbook?🚨",
    { reply_markup: generateCatchupTierKeyboard() }
  );
}

// ----------------------------------------------------------------------------
// CALLBACK HANDLER (Handles Calendar Taps)
// ----------------------------------------------------------------------------
export async function handleCatchupCallback(ctx: BotContext) {
  const data = ctx.callbackQuery?.data;
  if (!data) return;
  const state = ctx.session.catchup;

  if (data.startsWith("catchup_tier_")) {
    const tier = data.replace("catchup_tier_", "");
    if (!["QUICK_FIX", "FULL_BACKLOG", "VIP_DEFENSE"].includes(tier)) {
      await ctx.answerCallbackQuery("Invalid tier selection. Please try again.");
      return;
    }

    const telegramId = BigInt(ctx.from!.id);
    const dbUser = await prisma.user.findUnique({ where: { telegramId }, select: { id: true } });
    if (!dbUser) {
      await ctx.answerCallbackQuery("Couldn't find your account. Please type /start.");
      return;
    }

    const tierSelected = CatchupTier[tier as keyof typeof CatchupTier];

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

    const unit = getCatchupTierUnit(tier);
    await ctx.editMessageText(
      `Got it. Exactly how many ${unit} are you missing? (Type a number)`
    ).catch(() => {});
    await ctx.answerCallbackQuery();
    return;
  }

  if (data === "ccal_noop") {
    await ctx.answerCallbackQuery();
    return;
  }

  if (data === "ccal_cancel") {
    clearActiveFlow(ctx.session);
    await ctx.editMessageText("Catch-up cancelled. Let me know when you're ready! 🏠", {
      reply_markup: new InlineKeyboard().text("🏠 Menu", "nav_menu")
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
      "Tell me more about what you were doing during the rest of that period — rough notes are fine. 📝"
    );
    await ctx.answerCallbackQuery();
    return;
  }

  if (data === "catchup_skip") {
    clearActiveFlow(ctx.session);
    await ctx.editMessageText(
      "No problem — the logs I generated are already in your logbook. 👍",
      { reply_markup: new InlineKeyboard().text("📅 View calendar", "nav_calendar").text("🏠 Menu", "nav_menu") }
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
      await ctx.reply("You've already paid for this rescue — picking up right where we left off ✅");
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

    const userCourseOfStudy = (await prisma.user.findUnique({
      where: { id: catchupSession.userId },
      select: { courseOfStudy: true },
    }))?.courseOfStudy;

    if (!userCourseOfStudy) {
      ctx.session.catchup = {
        active: true,
        step: 'awaiting_course',
        startedAt: state.startedAt ?? Date.now(),
      };

      await ctx.editMessageText("Before we continue, what is your course or department?").catch(() => {});
      await ctx.answerCallbackQuery();
      return;
    }

    ctx.session.catchup = {
      active: true,
      step: 'awaiting_block_dump',
      startedAt: state.startedAt ?? Date.now(),
    };

    const dumpPrompt = (catchupSession.tierSelected === CatchupTier.QUICK_FIX
      ? `Perfect. Tell me everything you worked on during this entire ${catchupSession.totalDuration}-week period. Drop the projects, tools, challenges, and lessons. Leave nothing out.`
      : "Perfect. Tell me everything you worked on during this first month. Drop the projects, tools, challenges, and lessons. Leave nothing out.")
      + "\n\n*(You can type it out, or just send a voice note 🎙️)*";

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
    clearActiveFlow(ctx.session);
    await ctx.reply(
      "Your catch-up session expired after 2 hours of inactivity. Type /catchup to start a new one 👇"
    );
    return;
  }

  if (text.toLowerCase() === 'cancel' || text === '/cancel') {
    clearActiveFlow(ctx.session);
    await ctx.reply("Catch-up cancelled. Let me know when you're ready! 🏠", {
      reply_markup: new InlineKeyboard().text("🏠 Menu", "nav_menu")
    });
    return;
  }

  if (/^[^a-zA-Z0-9]*(catch up|fill missed days|catch up missed days)[^a-zA-Z0-9]*$/i.test(text)) {
    return startCatchupFlow(ctx);
  }

  const telegramId = BigInt(ctx.from!.id);

  try {
    switch (state.step) {
      case 'awaiting_duration': {
        // Fetched first — the valid range depends on the tier they picked.
        const catchupSession = await getCatchupSessionForCurrentUser(ctx);
        if (!catchupSession) {
          await ctx.reply("I couldn't find this catch-up session. Please type /catchup again.");
          return;
        }

        const cap = getMaxTierDuration(catchupSession.tierSelected);
        const duration = parseInt(text.trim(), 10);
        if (!Number.isFinite(duration) || duration <= 0 || duration > cap) {
          await ctx.reply(`Please send a valid number between 1 and ${cap}.`);
          return;
        }

        await prisma.catchupSession.update({
          where: { id: catchupSession.id },
          data: { totalDuration: duration },
        });

        const now = new Date();
        const calendarKb = generateCatchupCalendar(now.getFullYear(), now.getMonth(), 'start');

        ctx.session.catchup = {
          active: true,
          step: 'awaiting_anchor_date',
          startedAt: state.startedAt ?? Date.now(),
        };

        await ctx.reply("What exact date did this start?", {
          reply_markup: calendarKb,
        });
        return;
      }

      case 'awaiting_block_dump': {
        const appended = await appendCatchupDumpToSession(ctx, text);
        if (!appended) {
          await ctx.reply("I couldn't find this catch-up session. Please type /catchup again.");
          return;
        }

        await evaluateCurrentCatchupChunk(ctx, appended.blocks.flatMap((block) => block.entries).join("\n\n"));
        return;
      }

      case 'ready_for_week_1_generation': {
        await sendWeekOneBait(ctx);

        ctx.session.catchup = {
          active: true,
          step: 'ready_for_week_1_generation',
          startedAt: state.startedAt ?? Date.now(),
        };
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

        await ctx.reply(`✅ Saved! Generating your secure payment link, one sec...⏳`);

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
          "I'm still waiting on that payment. Tap *I have paid* on the invoice above once it's done — or send /cancel to stop.",
          { parse_mode: "Markdown" },
        );
        return;
      }

      case 'awaiting_course': {
        const courseText = text.trim();

        if (courseText.length < 2) {
          await ctx.reply("Please enter a valid Course of Study!");
          return;
        }

        if (courseText.length > 100) {
          await ctx.reply("Course of Study is too long. Please keep it under 100 characters.");
          return;
        }

        await prisma.user.update({
          where: { telegramId },
          data: { courseOfStudy: courseText },
        });

        ctx.session.catchup = {
          active: true,
          step: 'awaiting_block_dump',
          startedAt: state.startedAt ?? Date.now(),
        };

        const courseCatchupSession = await getCatchupSessionForCurrentUser(ctx);
        await ctx.reply(
          courseCatchupSession?.tierSelected === CatchupTier.QUICK_FIX
            ? `Got it! Now, tell me everything you worked on during this entire ${courseCatchupSession.totalDuration}-week period. Drop the projects, tools, challenges, and lessons. Leave nothing out.`
            : "Got it! Now, tell me everything you worked on during this first month. Drop the projects, tools, challenges, and lessons. Leave nothing out."
        );
        return;
      }

      case 'awaiting_more_detail': {
        const appended = await appendCatchupDumpToSession(ctx, text);
        if (!appended) {
          await ctx.reply("I couldn't find this catch-up session. Please type /catchup again.");
          return;
        }

        await evaluateCurrentCatchupChunk(ctx, appended.blocks.flatMap((block) => block.entries).join("\n\n"), { afterMoreDetail: true });
        return;
      }

      case 'awaiting_start_date':
      case 'awaiting_end_date':
      case 'awaiting_tier_selection':
      case 'awaiting_anchor_date': {
        // ✅ SILENT DELETION: Instead of nagging, silently delete stray text to keep chat clean
        await ctx.deleteMessage().catch(() => {});
        break;
      }

      // Escape hatch: any step with no handler (e.g. 'generating' after a failed
      // fulfilment) would otherwise swallow every message and brick the session.
      default: {
        await ctx.reply(
          "I lost track of where we were in your catch-up 😅 Type /catchup to pick it back up.",
          { reply_markup: new InlineKeyboard().text("🏠 Menu", "nav_menu") },
        );
        clearActiveFlow(ctx.session);
        return;
      }
    }
  } catch (error) {
    console.error("Error in catchup flow:", error);
    if (ctx.session.catchup) ctx.session.catchup.active = false;
    await ctx.reply(
      "Something went wrong on our end 😔\n\nYour dates and notes are still saved. Type /catchup to try again — you won't have to start over."
    );
  }
}

export async function handleCatchupFlow(ctx: BotContext): Promise<void> {
  const text = ctx.message?.text?.trim();
  const state = ctx.session.catchup;
  if (!text || !state) return;
  await handleCatchupFlowWithText(ctx, text);
}