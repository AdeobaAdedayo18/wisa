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
    paidSessions,
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

    // ── 4. Active / stuck ─────────────────────────────────────────────────
    // Completion is derived from a JSON ledger, which Postgres cannot aggregate
    // through Prisma's native helpers, so this is the one metric that needs the
    // rows themselves. Scoped to PAID sessions (the paying cohort, not every
    // abandoned tier tap) with a narrow select to keep the payload small.
    prisma.catchupSession.findMany({
      where: { paymentStatus: CatchupPaymentStatus.PAID },
      select: { tierSelected: true, totalDuration: true, contextDump: true, updatedAt: true },
    }),
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

  // ── Fulfilment ──────────────────────────────────────────────────────────
  let completed = 0;
  let stuck = 0;

  for (const session of paidSessions) {
    const totalBlocks = getCatchupTotalBlocks(session.tierSelected, session.totalDuration);
    const fulfilled = readFulfilledBlocks(session.contextDump);

    if (fulfilled.some((block) => block >= totalBlocks)) {
      completed += 1;
      continue;
    }

    // Paid, unfinished, and untouched for longer than a block claim lease —
    // the same window the abandoned-block sweeper uses.
    if (session.updatedAt < stuckCutoff) stuck += 1;
  }

  const inProgress = paidSessions.length - completed;

  const notes: string[] = [];
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
      paidTotal: paidSessions.length,
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
    notes,
  };
}
