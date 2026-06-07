-- Add storage-full monetization columns.
ALTER TABLE "User"
ADD COLUMN "paymentEmail" TEXT,
ADD COLUMN "storageUnlocked" BOOLEAN NOT NULL DEFAULT false,
ADD COLUMN "logCount" INTEGER NOT NULL DEFAULT 0,
ADD COLUMN "nextRenewalDate" TIMESTAMP(3);

-- Backfill log counts from existing logs so users already above 15 are correctly gated.
UPDATE "User" u
SET "logCount" = counts.cnt
FROM (
  SELECT "userId", COUNT(*)::INTEGER AS cnt
  FROM "Log"
  GROUP BY "userId"
) AS counts
WHERE counts."userId" = u.id;

-- Preserve legacy paid users if any are active at rollout.
UPDATE "User" u
SET
  "storageUnlocked" = true,
  "nextRenewalDate" = s."endDate"
FROM "Subscription" s
WHERE s."userId" = u.id
  AND u."isPro" = true
  AND s."status" = 'active'
  AND s."endDate" > NOW();
