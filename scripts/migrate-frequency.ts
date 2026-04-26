import "dotenv/config";
import { Bot } from "grammy";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/prisma/client";

const IS_DRY_RUN = true;
const DRY_RUN_TELEGRAM_ID = BigInt("5448700494");
const SEND_DELAY_MS = 100;

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });
const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN!);

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function buildMessage(firstName?: string | null): string {
  const safeName = firstName?.trim() ? firstName : "there";
  return `Hey ${safeName} 👋
Quick update on how Wisa works!

We've noticed that the students who log the most consistently are on a daily reminder — so we've moved everyone to daily reminders to help you build that habit and keep your logbook as complete as possible 📅

Don't worry, your logs are safe and nothing else has changed 🙏

If daily feels like too much for you, you can switch to every 2 days anytime from your settings — just tap ⚙️ Settings → Change log frequency

let's keep those logs coming 🚀`;
}

async function main(): Promise<void> {
  const where = IS_DRY_RUN
    ? { telegramId: DRY_RUN_TELEGRAM_ID }
    : undefined;

  const users = await prisma.user.findMany({
    ...(where ? { where } : {}),
    orderBy: { id: "asc" },
    select: {
      id: true,
      telegramId: true,
      firstName: true,
      logFrequency: true,
    },
  });

  if (!users.length) {
    console.log("No users found for this migration scope.");
    return;
  }

  const targetsForMessage = users.filter((user) => user.logFrequency !== "daily");

  console.log(
    `[migration] Starting frequency migration for ${users.length} user(s). Dry run: ${IS_DRY_RUN ? "yes" : "no"}`,
  );
  console.log(
    `[migration] Found ${users.length} users. ${targetsForMessage.length} need the broadcast.`,
  );

  // Update all target users to daily first.
  const updated = await prisma.user.updateMany({
    ...(where ? { where } : {}),
    data: { logFrequency: "daily" },
  });
  console.log(`[migration] Updated ${updated.count} user(s) to daily frequency.`);

  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < targetsForMessage.length; i++) {
    const user = targetsForMessage[i];
    const label = user.firstName?.trim() || "there";
    const prefix = `[${i + 1}/${targetsForMessage.length}]`;

    try {
      await bot.api.sendMessage(Number(user.telegramId), buildMessage(user.firstName));
      successCount += 1;
      console.log(`${prefix} Sent to ${label}`);
    } catch (error) {
      failCount += 1;
      console.error(`${prefix} Failed for ${label} (telegramId=${user.telegramId.toString()})`, error);
    }

    await delay(SEND_DELAY_MS);
  }

  console.log(
    `[migration] Complete. Success: ${successCount}, Failed: ${failCount}, Broadcast Targets: ${targetsForMessage.length}, Total Synced: ${users.length}`,
  );
}

main()
  .catch((error) => {
    console.error("[migration] Script failed:", error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
