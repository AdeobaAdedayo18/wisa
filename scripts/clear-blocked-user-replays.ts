/**
 * scripts/clear-blocked-user-replays.ts
 *
 * Clears ReplayEvent rows for users who have blocked the bot.
 * Runs a dry-run preview first, then prompts for confirmation.
 *
 * Usage:
 *   npx tsx scripts/clear-blocked-user-replays.ts
 */
import "dotenv/config";
import * as readline from "readline";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/prisma/client";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

function prompt(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  // Find all blocked users
  const blockedUsers = await prisma.user.findMany({
    where: { botBlocked: true },
    select: { id: true, telegramId: true, firstName: true, username: true },
  });

  if (blockedUsers.length === 0) {
    console.log("No blocked users found. Nothing to delete.");
    return;
  }

  console.log(`\nFound ${blockedUsers.length} blocked user(s):\n`);

  // Preview counts per user
  const rows: { user: string; telegramId: string; events: number }[] = [];

  for (const user of blockedUsers) {
    const count = await prisma.replayEvent.count({
      where: { telegramId: user.telegramId },
    });
    rows.push({
      user: `${user.firstName}${user.username ? ` (@${user.username})` : ""}`,
      telegramId: user.telegramId.toString(),
      events: count,
    });
  }

  const totalEvents = rows.reduce((sum, r) => sum + r.events, 0);

  console.table(rows);
  console.log(`\nTotal replay events to delete: ${totalEvents}\n`);

  const answer = await prompt("Type YES to confirm deletion, anything else to cancel: ");

  if (answer !== "YES") {
    console.log("Cancelled. Nothing was deleted.");
    return;
  }

  // Delete
  const telegramIds = blockedUsers.map((u) => u.telegramId);
  const result = await prisma.replayEvent.deleteMany({
    where: { telegramId: { in: telegramIds } },
  });

  console.log(`\nDone. Deleted ${result.count} replay event(s).`);
}

main()
  .catch((err) => {
    console.error("Error:", err);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
