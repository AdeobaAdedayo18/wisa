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

/** One row of the live "who is mid-flow right now" table. */
export type CatchupActiveSession = {
  sessionId: string;
  /** `User.firstName`. There is no surname column on User. */
  fullName: string;
  /** BigInt is not JSON-serialisable, so it ships as a string. */
  telegramId: string;
  username: string | null;
  tier: CatchupTier;
  tierLabel: string;
  /**
   * Live position in the conversation, read from the grammY session blob.
   * `CatchupSession` does not carry it — the step lives only in `Session.value`.
   * Falls back to "no session state" when that row is missing or unparseable.
   */
  step: string;
  state: "stuck" | "active" | "unpaid";
  paymentStatus: CatchupPaymentStatus;
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
  /** Unfinished sessions, most recently touched first. Capped, see `notes`. */
  activeSessions: CatchupActiveSession[];
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

/** How far back to look for unpaid sessions. Paid ones are never time-limited. */
const UNPAID_SESSION_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

/** Hard cap on table rows, so one runaway day cannot bloat the response. */
const ACTIVE_SESSION_LIMIT = 50;

/**
 * Reads each user's live conversation step out of the grammY session store.
 *
 * `CatchupSession` records the commercial state (tier, payment, blocks) but not
 * where the user is in the dialogue — that lives only in `Session.value`, a JSON
 * blob keyed by telegram id as a string. One `IN` query covers the whole page.
 */
async function readCatchupSteps(telegramIds: bigint[]): Promise<Map<string, string>> {
  const steps = new Map<string, string>();
  if (telegramIds.length === 0) return steps;

  const rows = await prisma.session.findMany({
    where: { key: { in: telegramIds.map((id) => id.toString()) } },
    select: { key: true, value: true },
  });

  for (const row of rows) {
    try {
      const catchup = (JSON.parse(row.value) as { catchup?: { active?: boolean; step?: string } }).catchup;
      if (!catchup) continue;
      steps.set(row.key, catchup.active ? catchup.step ?? "unknown" : `${catchup.step ?? "none"} (inactive)`);
    } catch {
      // Unparseable blob: leave unset so the caller shows its fallback.
    }
  }

  return steps;
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
    openSessions,
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

    // ── Active sessions table ─────────────────────────────────────────────
    // Every PAID session, because unfinished paid work is money at risk and must
    // never age out of view. Unpaid ones are windowed, since an abandoned tier
    // tap from months ago is noise rather than something to act on.
    prisma.catchupSession.findMany({
      where: {
        OR: [
          { paymentStatus: CatchupPaymentStatus.PAID },
          {
            paymentStatus: CatchupPaymentStatus.PENDING,
            updatedAt: { gte: new Date(now.getTime() - UNPAID_SESSION_WINDOW_MS) },
          },
        ],
      },
      orderBy: { updatedAt: "desc" },
      include: {
        user: { select: { firstName: true, telegramId: true, username: true } },
      },
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

  // ── Active sessions table ───────────────────────────────────────────────
  // Completion lives in the JSON ledger, so finished sessions are filtered here
  // rather than in SQL. Ordering is already newest-first from the query.
  const unfinished = openSessions.filter((session) => {
    const totalBlocks = getCatchupTotalBlocks(session.tierSelected, session.totalDuration);
    return !readFulfilledBlocks(session.contextDump).some((block) => block >= totalBlocks);
  });

  const steps = await readCatchupSteps(unfinished.slice(0, ACTIVE_SESSION_LIMIT).map((s) => s.user.telegramId));

  const activeSessions: CatchupActiveSession[] = unfinished
    .slice(0, ACTIVE_SESSION_LIMIT)
    .map((session) => {
      const telegramId = session.user.telegramId.toString();
      const isPaid = session.paymentStatus === CatchupPaymentStatus.PAID;
      const totalBlocks = getCatchupTotalBlocks(session.tierSelected, session.totalDuration);
      const fulfilledCount = readFulfilledBlocks(session.contextDump).filter(
        (block) => block >= 1 && block <= totalBlocks,
      ).length;

      return {
        sessionId: session.id,
        fullName: session.user.firstName,
        telegramId,
        username: session.user.username,
        tier: session.tierSelected,
        tierLabel: TIER_LABELS[session.tierSelected] ?? session.tierSelected,
        step: steps.get(telegramId) ?? "no session state",
        state: !isPaid ? "unpaid" : session.updatedAt < stuckCutoff ? "stuck" : "active",
        paymentStatus: session.paymentStatus,
        blockProgress: `${fulfilledCount} / ${totalBlocks}`,
        updatedAt: session.updatedAt.toISOString(),
        minutesSinceUpdate: Math.round((now.getTime() - session.updatedAt.getTime()) / 60000),
      };
    });

  const notes: string[] = [];
  if (unfinished.length > ACTIVE_SESSION_LIMIT) {
    notes.push(
      `Showing the ${ACTIVE_SESSION_LIMIT} most recently active of ${unfinished.length} unfinished sessions.`,
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
    activeSessions,
    notes,
  };
}
