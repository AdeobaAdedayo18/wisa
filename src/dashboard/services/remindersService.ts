import { prisma } from "../../lib/prisma";
import { formatDateUtc, formatHourLabelUtc } from "../utils/date";

export async function getReminders(): Promise<Record<string, unknown>> {
  const [
    sent,
    skipped,
    snoozed,
    converted,
    reminderRows,
    timeBuckets,
  ] = await Promise.all([
    prisma.reminderJob.count({ where: { status: "sent" } }),
    prisma.reminderJob.count({ where: { status: "skipped" } }),
    prisma.reminderJob.count({ where: { status: "snoozed" } }),
    prisma.reminderJob.count({ where: { convertedAt: { not: null } } }),
    prisma.reminderJob.findMany({
      orderBy: { scheduledFor: "desc" },
      include: { user: { select: { firstName: true, username: true } } },
    }),
    prisma.$queryRaw<Array<{ hour: number; total: bigint; converted: bigint }>>`
      SELECT
        EXTRACT(HOUR FROM "scheduledFor" AT TIME ZONE 'UTC')::int AS hour,
        COUNT(*)::bigint AS total,
        COUNT(*) FILTER (WHERE "convertedAt" IS NOT NULL)::bigint AS converted
      FROM "ReminderJob"
      GROUP BY hour
      ORDER BY hour
    `,
  ]);

  const timeEffectiveness = timeBuckets.map((row) => ({
    time: formatHourLabelUtc(row.hour),
    conversionRate: Number(row.total) > 0 ? Math.round((Number(row.converted) / Number(row.total)) * 100) : 0,
  }));

  return {
    stats: {
      sent,
      skipped,
      snoozed,
      converted,
    },
    timeEffectiveness,
    reminders: reminderRows.map((job) => ({
      id: job.id.toString(),
      userName: job.user?.firstName ?? "Unknown",
      username: job.user?.username ?? null,
      reminderTime: formatHourLabelUtc(job.scheduledFor.getUTCHours()),
      status: job.convertedAt ? "converted" : job.status,
      snoozeCount: job.snoozeCount,
      date: formatDateUtc(job.scheduledFor),
    })),
  };
}
