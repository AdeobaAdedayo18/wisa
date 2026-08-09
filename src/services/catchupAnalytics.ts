import { prisma } from "../lib/prisma";
import { CatchupPaymentStatus, CatchupTier, TransactionStatus } from "../prisma/enums";
import { RESCUE_PASS_PAYMENT_TYPE } from "./paystack";
import {
  CATCHUP_BLOCK_CLAIM_LEASE_MS,
  getCatchupTierPrice,
  getCatchupTierUnit,
  getCatchupTotalBlocks,
} from "./catchupTiers";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type CatchupTierBreakdown = {
  tier: CatchupTier;
  unitPriceNaira: number;
  durationUnit: "weeks" | "months";
  /** Sessions opened at this tier, regardless of whether they were paid for. */
  initiatedCount: number;
  paidCount: number;
  expectedRevenueNaira: number;
  /** Mean `totalDuration` across PAID sessions — weeks or months, per the tier. */
  averageDuration: number | null;
};

/** One paying customer, and whether they actually got their logs. */
export type CatchupPaidSession = {
  sessionId: string;
  /** `User.firstName`. There is no surname column on User. */
  fullName: string;
  /** BigInt is not JSON-serialisable, so it ships as a string. */
  telegramId: string;
  username: string | null;
  tier: CatchupTier;
  tierLabel: string;
  /**
   * What they were ACTUALLY charged, read off the settled PaymentTransaction.
   * Falls back to the tier's current list price only when no transaction row can
   * be matched, since list price misreports anything sold before a price change.
   */
  amountNaira: number;
  /** True when the figure above is the fallback rather than a real charge. */
  amountIsListPrice: boolean;
  state: "completed" | "stuck" | "in_progress";
  /** e.g. "2 / 6". Blocks fulfilled out of blocks owed. */
  blockProgress: string;
  updatedAt: string;
  minutesSinceUpdate: number;
};

export type CatchupAnalytics = {
  generatedAt: string;
  currency: "NGN";
  revenue: {
    /** Sum of list prices for PAID sessions. See the caveat in `notes`. */
    expectedNaira: number;
    /** Actually settled Rescue Pass charges, from PaymentTransaction. */
    collectedNaira: number;
  };
  funnel: {
    sessionsInitiated: number;
    sessionsPaid: number;
    conversionRatePct: number;
  };
  tiers: CatchupTierBreakdown[];
  fulfilment: {
    paidTotal: number;
    completed: number;
    /** Paid but the final block is not fulfilled yet. */
    inProgress: number;
    /** SUBSET of `inProgress` — untouched for longer than a block claim lease. */
    stuck: number;
    stuckThresholdMinutes: number;
  };
  dataRejection: {
    tracked: boolean;
    count: number | null;
    rejectionRatePct: number | null;
    note: string;
  };
  /** Paying customers, most recently active first. Capped, see `notes`. */
  paidSessions: CatchupPaidSession[];
  notes: string[];
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ALL_TIERS: CatchupTier[] = [
  CatchupTier.QUICK_FIX,
  CatchupTier.FULL_BACKLOG,
  CatchupTier.VIP_DEFENSE,
];

function ratePct(part: number, whole: number): number {
  if (whole <= 0) return 0;
  return Math.round((part / whole) * 1000) / 10;
}

/**
 * Reads the fulfilment ledger out of `contextDump`.
 *
 * There is no `isCompleted` column — a block is marked done by appending its
 * index to `contextDump.fulfilledBlocks` in the same transaction that writes its
 * logs. Legacy dumps are a bare array of blocks with no ledger at all, which
 * correctly reads as "nothing fulfilled".
 */
function readFulfilledBlocks(contextDump: unknown): number[] {
  if (!contextDump || typeof contextDump !== "object" || Array.isArray(contextDump)) return [];
  const blocks = (contextDump as { fulfilledBlocks?: unknown }).fulfilledBlocks;
  if (!Array.isArray(blocks)) return [];
  return blocks.filter((block): block is number => typeof block === "number" && Number.isFinite(block));
}

const TIER_LABELS: Record<CatchupTier, string> = {
  [CatchupTier.QUICK_FIX]: "Quick Fix",
  [CatchupTier.FULL_BACKLOG]: "Full Backlog",
  [CatchupTier.VIP_DEFENSE]: "VIP Defense",
};

/** Hard cap on table rows, so a long sales run cannot bloat the response. */
const PAID_SESSION_LIMIT = 100;

/**
 * Maps each catch-up session to the amount actually settled for it.
 *
 * Rescue Pass charges carry their session id on the transaction metadata, set
 * when the invoice is minted. Read back here rather than pricing rows from the
 * current tier table, which would misreport anything sold before a price change.
 */
async function readSettledAmounts(): Promise<Map<string, number>> {
  const rows = await prisma.paymentTransaction.findMany({
    where: {
      status: TransactionStatus.SUCCESS,
      metadata: { path: ["payment_type"], equals: RESCUE_PASS_PAYMENT_TYPE },
    },
    select: { amount: true, metadata: true },
  });

  const amounts = new Map<string, number>();
  for (const row of rows) {
    const sessionId = (row.metadata as { catchup_session_id?: unknown } | null)?.catchup_session_id;
    if (typeof sessionId !== "string") continue;
    // Kobo to naira. Keep the largest if a session somehow has two settled
    // charges, so a double-charge shows up rather than hiding behind the first.
    amounts.set(sessionId, Math.max(amounts.get(sessionId) ?? 0, Math.round(row.amount / 100)));
  }

  return amounts;
}

// ---------------------------------------------------------------------------
// The aggregation
// ---------------------------------------------------------------------------

export async function getCatchupAnalytics(): Promise<CatchupAnalytics> {
  const now = new Date();
  const stuckCutoff = new Date(now.getTime() - CATCHUP_BLOCK_CLAIM_LEASE_MS);

  const [
    sessionsInitiated,
    sessionsPaid,
    paidByTier,
    initiatedByTier,
    collectedAggregate,
    paidSessionRows,
    settledAmounts,
  ] = await Promise.all([
    // ── 2. Conversion funnel ──────────────────────────────────────────────
    prisma.catchupSession.count(),
    prisma.catchupSession.count({ where: { paymentStatus: CatchupPaymentStatus.PAID } }),

    // ── 1 + 3. Revenue and popularity, from one grouped scan ──────────────
    prisma.catchupSession.groupBy({
      by: ["tierSelected"],
      where: { paymentStatus: CatchupPaymentStatus.PAID },
      _count: { _all: true },
      _avg: { totalDuration: true },
    }),
    prisma.catchupSession.groupBy({
      by: ["tierSelected"],
      _count: { _all: true },
    }),

    // Ground truth for revenue: what Paystack actually settled. Rescue Pass
    // charges are tagged on the transaction metadata at creation time.
    prisma.paymentTransaction.aggregate({
      _sum: { amount: true },
      where: {
        status: TransactionStatus.SUCCESS,
        metadata: { path: ["payment_type"], equals: RESCUE_PASS_PAYMENT_TYPE },
      },
    }),

    // ── 4. Fulfilment health AND the paid-customer table ──────────────────
    // One scan serves both. Completion is derived from a JSON ledger, which
    // Postgres cannot aggregate through Prisma's native helpers, so the rows are
    // needed anyway. Scoped to PAID: unpaid sessions are funnel drop-off, not
    // customers, and mixing them in was what made the old table unreadable.
    prisma.catchupSession.findMany({
      where: { paymentStatus: CatchupPaymentStatus.PAID },
      orderBy: { updatedAt: "desc" },
      include: {
        user: { select: { firstName: true, telegramId: true, username: true } },
      },
    }),

    readSettledAmounts(),
  ]);

  // ── Tier breakdown ──────────────────────────────────────────────────────
  const paidByTierMap = new Map(paidByTier.map((row) => [row.tierSelected, row]));
  const initiatedByTierMap = new Map(initiatedByTier.map((row) => [row.tierSelected, row]));

  const tiers: CatchupTierBreakdown[] = ALL_TIERS.map((tier) => {
    const paidRow = paidByTierMap.get(tier);
    const paidCount = paidRow?._count._all ?? 0;
    const unitPriceNaira = getCatchupTierPrice(tier);
    const averageDuration = paidRow?._avg.totalDuration ?? null;

    return {
      tier,
      unitPriceNaira,
      durationUnit: getCatchupTierUnit(tier),
      initiatedCount: initiatedByTierMap.get(tier)?._count._all ?? 0,
      paidCount,
      expectedRevenueNaira: paidCount * unitPriceNaira,
      averageDuration: averageDuration === null ? null : Math.round(averageDuration * 10) / 10,
    };
  });

  const expectedNaira = tiers.reduce((sum, tier) => sum + tier.expectedRevenueNaira, 0);
  // PaymentTransaction.amount is stored in kobo.
  const collectedNaira = Math.round((collectedAggregate._sum.amount ?? 0) / 100);

  // ── Fulfilment health + the paid-customer table, from one pass ──────────
  let completed = 0;
  let stuck = 0;

  const paidSessions: CatchupPaidSession[] = paidSessionRows.map((session) => {
    const totalBlocks = getCatchupTotalBlocks(session.tierSelected, session.totalDuration);
    const fulfilled = readFulfilledBlocks(session.contextDump);
    const isComplete = fulfilled.some((block) => block >= totalBlocks);

    // Unfinished and untouched for longer than a block claim lease — the same
    // window the abandoned-block sweeper uses to decide a worker died.
    const isStuck = !isComplete && session.updatedAt < stuckCutoff;

    if (isComplete) completed += 1;
    else if (isStuck) stuck += 1;

    const settled = settledAmounts.get(session.id);

    return {
      sessionId: session.id,
      fullName: session.user.firstName,
      telegramId: session.user.telegramId.toString(),
      username: session.user.username,
      tier: session.tierSelected,
      tierLabel: TIER_LABELS[session.tierSelected] ?? session.tierSelected,
      amountNaira: settled ?? getCatchupTierPrice(session.tierSelected),
      amountIsListPrice: settled === undefined,
      state: isComplete ? "completed" : isStuck ? "stuck" : "in_progress",
      blockProgress: `${fulfilled.filter((b) => b >= 1 && b <= totalBlocks).length} / ${totalBlocks}`,
      updatedAt: session.updatedAt.toISOString(),
      minutesSinceUpdate: Math.round((now.getTime() - session.updatedAt.getTime()) / 60000),
    };
  });

  const inProgress = paidSessionRows.length - completed;

  const notes: string[] = [];
  if (paidSessions.length > PAID_SESSION_LIMIT) {
    notes.push(
      `Showing the ${PAID_SESSION_LIMIT} most recently active of ${paidSessions.length} paid sessions.`,
    );
  }
  if (expectedNaira !== collectedNaira) {
    notes.push(
      "`revenue.expectedNaira` prices every paid session at today's list price, so it diverges from " +
        "`collectedNaira` for sessions sold before a price change (QUICK_FIX was ₦1,000 before it moved to ₦1,500). " +
        "Treat `collectedNaira` as the accounting figure.",
    );
  }

  return {
    generatedAt: now.toISOString(),
    currency: "NGN",
    revenue: { expectedNaira, collectedNaira },
    funnel: {
      sessionsInitiated,
      sessionsPaid,
      conversionRatePct: ratePct(sessionsPaid, sessionsInitiated),
    },
    tiers,
    fulfilment: {
      paidTotal: paidSessionRows.length,
      completed,
      inProgress,
      stuck,
      stuckThresholdMinutes: Math.round(CATCHUP_BLOCK_CLAIM_LEASE_MS / 60000),
    },
    // ── 5. Data rejection rate ────────────────────────────────────────────
    // NOT TRACKED. `evaluateCatchupDump` returns `sufficientForCurrentChunk:
    // false` and the flow moves the user to the `awaiting_more_detail` step, but
    // that lives only in the grammY session — it is overwritten on the next
    // message and never persisted as an event, so there is nothing to aggregate.
    //
    // TODO: to make this measurable, write a row per evaluation (session id,
    // block index, verdict, question count) from `evaluateCurrentCatchupChunk`.
    // The rate is then `rejected / total evaluations` over any window. Shipping
    // the key now as an explicit null keeps the response shape stable for the
    // dashboard once the data exists.
    dataRejection: {
      tracked: false,
      count: null,
      rejectionRatePct: null,
      note: "Not tracked yet — LLM insufficient-data pushbacks are held in session state only, never persisted.",
    },
    paidSessions: paidSessions.slice(0, PAID_SESSION_LIMIT),
    notes,
  };
}
