import { CatchupTier } from "../prisma/enums";

/**
 * Shared catch-up tier facts.
 *
 * Deliberately free of any bot/grammY imports so the dashboard can read it
 * without pulling in the Telegram bot module graph. Pricing and block maths used
 * to live only inside `bot/catchupFlow.ts`; analytics that recomputed them
 * locally would silently drift the moment a price changed.
 */

/** Naira price per tier. */
export const CATCHUP_TIER_PRICES: Record<CatchupTier, number> = {
  [CatchupTier.QUICK_FIX]: 1500,
  [CatchupTier.FULL_BACKLOG]: 2500,
  // Retired from the tier keyboard, but priced on purpose: sessions and pending
  // invoices created before the retirement must still resolve to ₦4,000.
  [CatchupTier.VIP_DEFENSE]: 4000,
};

export function getCatchupTierPrice(tier: CatchupTier): number {
  return CATCHUP_TIER_PRICES[tier] ?? CATCHUP_TIER_PRICES[CatchupTier.QUICK_FIX];
}

/**
 * Hard ceiling on totalDuration per tier — weeks for QUICK_FIX, months otherwise.
 * QUICK_FIX feeds `totalDuration * 5` days into a single OpenAI request, so an
 * unbounded value here turns into an unbounded completion.
 */
export const MAX_TIER_DURATION: Record<CatchupTier, number> = {
  [CatchupTier.QUICK_FIX]: 4,
  [CatchupTier.FULL_BACKLOG]: 6,
  [CatchupTier.VIP_DEFENSE]: 6,
};

export function getMaxTierDuration(tier: CatchupTier): number {
  return MAX_TIER_DURATION[tier] ?? 4;
}

export function getCatchupTierUnit(tier: CatchupTier): "weeks" | "months" {
  return tier === CatchupTier.QUICK_FIX ? "weeks" : "months";
}

/**
 * How many generation blocks a session is made of.
 *
 * QUICK_FIX (1–4 weeks) is written in a single pass, so it is always one block.
 * The longer tiers use one block per month, clamped the same way
 * `resumeCatchupGeneration` clamps it — rows written before the tier caps
 * existed can hold any number.
 */
export function getCatchupTotalBlocks(tier: CatchupTier, totalDuration: number): number {
  if (tier === CatchupTier.QUICK_FIX) return 1;
  return Math.min(Math.max(1, totalDuration), getMaxTierDuration(tier));
}

/**
 * A block claim older than this is treated as abandoned (the worker died).
 * Shared with the analytics endpoint so "stuck" means the same thing there as
 * it does to the sweeper that reclaims those blocks.
 *
 * MUST stay above the worst-case OpenAI call, because generation performs no DB
 * writes and so cannot refresh `updatedAt` mid-flight — all the margin comes
 * from this constant. Reclaiming a block that is still generating pays OpenAI
 * twice and sends the completion message twice.
 *
 * The client is pinned to a 90s timeout with 1 retry, so the worst case is
 * about 3 minutes. 10 minutes leaves roughly 3x headroom while keeping crash
 * recovery fast: this is also how long a paid user waits before the boot sweep
 * will pick their orphaned block back up.
 */
export const CATCHUP_BLOCK_CLAIM_LEASE_MS = 10 * 60 * 1000;
