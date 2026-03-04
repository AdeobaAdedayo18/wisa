/**
 * scripts/cleanup-replay-events.ts
 *
 * Manually purge ReplayEvent rows older than a configurable number of days.
 *
 * Usage:
 *   npx ts-node scripts/cleanup-replay-events.ts          # defaults to 30 days
 *   npx ts-node scripts/cleanup-replay-events.ts --days 7 # custom retention
 */
import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/prisma/client";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

// --------------------------------------------------------------------------
// Parse --days argument (default 30)
// --------------------------------------------------------------------------
const daysArg = process.argv.indexOf("--days");
const days =
  daysArg !== -1 && process.argv[daysArg + 1]
    ? parseInt(process.argv[daysArg + 1], 10)
    : 30;

if (isNaN(days) || days < 1) {
  console.error("Invalid --days value. Must be a positive integer.");
  process.exit(1);
}

async function main() {
  const cutoff = new Date(Date.now() - days * 24 * 60 * 60 * 1000);

  console.log(
    `Deleting ReplayEvents older than ${days} day(s) (before ${cutoff.toISOString()}) …`,
  );

  const result = await prisma.replayEvent.deleteMany({
    where: { timestamp: { lt: cutoff } },
  });

  console.log(`Done. Deleted ${result.count} replay event(s).`);
}

main()
  .catch((err) => {
    console.error("Error during cleanup:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
