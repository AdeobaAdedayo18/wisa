import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/prisma/client";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

async function main() {
  // 1. Get all pending jobs ordered by scheduledFor
  const pendingJobs = await prisma.reminderJob.findMany({
    where: { status: "pending" },
    orderBy: { scheduledFor: "asc" },
  });

  // 2. For each user, keep up to TWO legitimate pending jobs:
  //    - One near-term (snooze / due within 4 hours)
  //    - One far-term  (next scheduled reminder, > 4 hours away)
  //    Any extras beyond that are duplicates and should be deleted.
  const fourHoursFromNow = new Date(Date.now() + 4 * 60 * 60 * 1000);
  const keepIds = new Set<number>();
  const deleteIds: number[] = [];

  // Track per user: has a near-term been kept? has a far-term been kept?
  const nearKept = new Set<number>();
  const farKept = new Set<number>();

  for (const job of pendingJobs) {
    const isNear = job.scheduledFor < fourHoursFromNow;
    if (isNear) {
      if (nearKept.has(job.userId)) {
        deleteIds.push(job.id); // duplicate near-term
      } else {
        nearKept.add(job.userId);
        keepIds.add(job.id);
      }
    } else {
      if (farKept.has(job.userId)) {
        deleteIds.push(job.id); // duplicate far-term
      } else {
        farKept.add(job.userId);
        keepIds.add(job.id);
      }
    }
  }

  const uniqueUsers = new Set([...nearKept, ...farKept]);
  console.log("Pending jobs total:", pendingJobs.length);
  console.log("Users with pending jobs:", uniqueUsers.size);
  console.log("Jobs to keep:", keepIds.size);
  console.log("Jobs to DELETE:", deleteIds.length);

  // 3. Delete the duplicate pending jobs
  if (deleteIds.length > 0) {
    const result = await prisma.reminderJob.deleteMany({
      where: { id: { in: deleteIds } },
    });
    console.log("Deleted:", result.count, "duplicate pending jobs");
  }

  // 4. Also clean up old snoozed/sent jobs to reduce table bloat (keep last 7 days)
  const oneWeekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const oldCleanup = await prisma.reminderJob.deleteMany({
    where: {
      status: { in: ["sent", "snoozed", "skipped"] },
      createdAt: { lt: oneWeekAgo },
    },
  });
  console.log("Deleted", oldCleanup.count, "old completed/snoozed/skipped jobs");

  // 5. Final count
  const remaining = await prisma.reminderJob.count();
  console.log("Remaining ReminderJob rows:", remaining);

  const remainingPending = await prisma.reminderJob.groupBy({
    by: ["userId"],
    _count: true,
    where: { status: "pending" },
  });
  console.log("Pending per user after cleanup:");
  for (const r of remainingPending) {
    console.log("  userId", r.userId, ":", r._count, "pending");
  }

  await prisma.$disconnect();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
