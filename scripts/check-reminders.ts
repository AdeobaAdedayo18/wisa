import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/prisma/client";

const adapter = new PrismaPg({ connectionString: process.env.DATABASE_URL! });
const prisma = new PrismaClient({ adapter });

function getLocalHHMM(date: Date, timezone: string): string {
  return new Intl.DateTimeFormat("en-GB", {
    timeZone: timezone,
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
}

async function main() {
  const now = new Date();
  console.log(`\n=== CURRENT TIME (UTC): ${now.toISOString()} ===\n`);

  // All users who have completed onboarding
  const users = await prisma.user.findMany({
    where: { onboardingDone: true },
    orderBy: { id: "asc" },
    select: {
      id: true,
      telegramId: true,
      firstName: true,
      reminderTime: true,
      timezone: true,
      isPro: true,
      botBlocked: true,
      logFrequency: true,
    },
  });

  // All pending/sent jobs
  const activeJobs = await prisma.reminderJob.findMany({
    where: { status: { in: ["pending", "sent"] } },
    orderBy: { scheduledFor: "asc" },
  });

  const jobsByUser = new Map<number, typeof activeJobs>();
  for (const job of activeJobs) {
    if (!jobsByUser.has(job.userId)) jobsByUser.set(job.userId, []);
    jobsByUser.get(job.userId)!.push(job);
  }

  const msInMin = 60 * 1000;
  const msInHr = 60 * msInMin;

  const mismatches: string[] = [];
  const noJobUsers: string[] = [];
  const staleUsers: string[] = [];

  console.log("=== USER REMINDER STATUS ===\n");

  for (const user of users) {
    const jobs = jobsByUser.get(user.id) ?? [];
    const flag = user.botBlocked ? " ⛔ BOT BLOCKED" : "";

    if (jobs.length === 0) {
      if (!user.botBlocked) {
        noJobUsers.push(`  User ${user.id} (${user.firstName}) reminderTime=${user.reminderTime} freq=${user.logFrequency}`);
      }
      console.log(`User ${user.id} | ${user.reminderTime} | ${user.logFrequency} | pro=${user.isPro}${flag} ⚠️  NO QUEUED JOB`);
      console.log();
      continue;
    }

    for (const j of jobs) {
      const diffMs = j.scheduledFor.getTime() - now.getTime();
      const overdue = diffMs < 0;
      const absDiff = Math.abs(diffMs);
      const hrs = Math.floor(absDiff / msInHr);
      const mins = Math.floor((absDiff % msInHr) / msInMin);
      const overdueLabel = overdue ? ` ← -${hrs}h${mins}m OVERDUE` : ``;

      // What local time does this job fire at in the user's timezone?
      const localFireTime = getLocalHHMM(j.scheduledFor, user.timezone);
      const timeMismatch = localFireTime !== user.reminderTime;
      const mismatchLabel = timeMismatch ? ` ❌ FIRES AT ${localFireTime} local (expected ${user.reminderTime})` : "";

      if (timeMismatch) {
        mismatches.push(`  User ${user.id} (${user.firstName}) job#${j.id}: fires at ${localFireTime} local but reminderTime=${user.reminderTime}`);
      }
      if (overdue && j.autoNudgeCount >= 3) {
        staleUsers.push(`  User ${user.id} (${user.firstName}) job#${j.id} nudge=3 overdue ${hrs}h${mins}m`);
      }

      console.log(
        `User ${user.id} | set=${user.reminderTime} | fires=${localFireTime}${timeMismatch ? " ❌" : " ✅"} | ${j.status} nudge=${j.autoNudgeCount} | job#${j.id} @ ${j.scheduledFor.toISOString()}${overdueLabel}${mismatchLabel}`
      );
    }

    if (jobs.length > 1) {
      console.log(`  ⚠️  ${jobs.length} active jobs`);
    }
    console.log();
  }

  // Summary
  console.log("=== SUMMARY ===\n");
  console.log(`Total onboarded users: ${users.length}`);
  console.log(`Users with no queued job (non-blocked): ${noJobUsers.length}`);
  if (noJobUsers.length) noJobUsers.forEach(u => console.log(u));

  console.log(`\nTime MISMATCHES (fires at wrong local time): ${mismatches.length}`);
  if (mismatches.length) mismatches.forEach(m => console.log(m));

  console.log(`\nStale sent+nudge=3 jobs (never cleaned up): ${staleUsers.length}`);
  if (staleUsers.length) staleUsers.forEach(s => console.log(s));
}

main()
  .catch(console.error)
  .finally(() => prisma.$disconnect());
