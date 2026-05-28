import "dotenv/config";
import * as prismaMod from "../src/lib/prisma.ts";

const { prisma } = prismaMod as typeof prismaMod & { prisma: { $queryRawUnsafe: (query: string) => Promise<unknown>; $disconnect: () => Promise<void> } };

const query = `
SELECT 
  COUNT(*) as total_onboarded,

  -- Activation breakdown
  COUNT(*) FILTER (WHERE "logCount" = 0) as never_logged,
  COUNT(*) FILTER (WHERE "logCount" BETWEEN 1 AND 3) as early_dropout,
  COUNT(*) FILTER (WHERE "logCount" BETWEEN 4 AND 9) as almost_habit,
  COUNT(*) FILTER (WHERE "logCount" >= 10) as habit_formed,

  -- Course of study coverage
  COUNT(*) FILTER (WHERE "courseOfStudy" IS NOT NULL) as has_course,
  COUNT(*) FILTER (WHERE "courseOfStudy" IS NULL) as no_course,

  -- Dormant users (haven't logged in 5-14 days)
  COUNT(*) FILTER (
    WHERE "logCount" > 0
    AND EXISTS (
      SELECT 1
      FROM "Log" l
      WHERE l."userId" = "User"."id"
      GROUP BY l."userId"
      HAVING MAX(l."logDate") BETWEEN NOW() - INTERVAL '14 days'
      AND NOW() - INTERVAL '5 days'
    )
  ) as dormant_with_logs,

  -- Draft test candidates (dormant + have course of study)
  COUNT(*) FILTER (
    WHERE "courseOfStudy" IS NOT NULL
    AND "logCount" > 0
    AND EXISTS (
      SELECT 1
      FROM "Log" l
      WHERE l."userId" = "User"."id"
      GROUP BY l."userId"
      HAVING MAX(l."logDate") BETWEEN NOW() - INTERVAL '14 days'
      AND NOW() - INTERVAL '5 days'
    )
  ) as draft_test_candidates,

  COUNT(*) FILTER (WHERE "storageUnlocked" = true OR "isPro" = true) as pro_users,
  COUNT(*) FILTER (WHERE "hitPaywall" = true) as hit_paywall,
  COUNT(*) FILTER (
    WHERE "hitPaywall" = true 
    AND "storageUnlocked" = false
    AND "isPro" = false
  ) as hit_paywall_did_not_convert

FROM "User"
WHERE "onboardingDone" = true;
`;

async function main(): Promise<void> {
  try {
    const rows = await prisma.$queryRawUnsafe(query);
    const serializableRows = JSON.parse(
      JSON.stringify(rows, (_key, value) => (typeof value === "bigint" ? Number(value) : value)),
    );
    console.log(JSON.stringify(serializableRows, null, 2));
  } finally {
    await prisma.$disconnect();
  }
}

void main();
