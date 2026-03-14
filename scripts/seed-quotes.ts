/**
 * scripts/seed-quotes.ts
 *
 * Seeds the WeeklyQuote table with IT-student advice quotes.
 * Run once (or any time you add new quotes):
 *   npx tsx scripts/seed-quotes.ts
 *
 * Uses upsert so it's safe to re-run — existing quotes are updated if changed,
 * new ones are inserted.
 */

import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/prisma/client";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

const quotes: { weekNumber: number; quote: string; attribution?: string }[] = [
  {
    weekNumber: 1,
    quote:
      "No matter where you are doing your IT, even though it wasn't where you planned to do it, always look at it from the angle of, God has put me here for a reason. How can I be a blessing to this place, and how can I be blessed also?",
    attribution: undefined,
  },

  {
    weekNumber: 2,
    quote:
      "Don't be dead weight, if they are not giving you things to do, find problems and things you can do and then ask to do them and then you deliver on what you say, keep in mind most of these people are very busy so you have to be very persistent",
    attribution: undefined,
  },

  // ── Add more quotes below as the weeks go on ────────────────────────────

  // {
  //   weekNumber: 2,
  //   quote: "Your quote here.",
  //   attribution: "Name (optional)",
  // },
];

async function main() {
  console.log(`Seeding ${quotes.length} weekly quote(s)...\n`);

  for (const q of quotes) {
    await prisma.weeklyQuote.upsert({
      where: { weekNumber: q.weekNumber },
      update: { quote: q.quote, attribution: q.attribution ?? null },
      create: { weekNumber: q.weekNumber, quote: q.quote, attribution: q.attribution ?? null },
    });
    console.log(`  ✓  Week ${q.weekNumber}: "${q.quote.slice(0, 60)}…"`);
  }

  console.log("\nDone ✅");
}

main()
  .catch((e) => {
    console.error("Seed failed:", e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
