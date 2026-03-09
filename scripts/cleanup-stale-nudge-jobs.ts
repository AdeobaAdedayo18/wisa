import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/prisma/client";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

async function main() {
  const result = await prisma.reminderJob.updateMany({
    where: { status: "sent", autoNudgeCount: { gte: 3 } },
    data: { status: "skipped" },
  });
  console.log(`Cleaned up ${result.count} stale sent+nudge>=3 jobs → skipped`);
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
