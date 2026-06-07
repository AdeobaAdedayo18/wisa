import { prisma } from "../../lib/prisma";
import { localTimeToUtc } from "../../utils/dateHelpers";
import { formatDateUtc, formatHourLabelUtc } from "../utils/date";

export async function getReminders(): Promise<Record<string, unknown>> {
  const cutoff = localTimeToUtc("00:00", "Africa/Lagos", 0);
  const [
    reminderStats,
    reminderRows,
    timeBuckets,
  ] = await Promise.all([
    prisma.$queryRaw<Array<{ sent: bigint; skipped: bigint; snoozed: bigint; converted: bigint }>>`
      SELECT
        COUNT(DISTINCT "reminderJobId") FILTER (WHERE "eventType" = 'sent')::bigint AS sent,
        COUNT(DISTINCT "reminderJobId") FILTER (WHERE "eventType" = 'skipped')::bigint AS skipped,
        COUNT(DISTINCT "reminderJobId") FILTER (WHERE "eventType" = 'snoozed')::bigint AS snoozed,
        COUNT(DISTINCT "reminderJobId") FILTER (WHERE "eventType" = 'converted')::bigint AS converted
      FROM "ReminderEvent"
      WHERE "createdAt" >= ${cutoff}
    `,
    prisma.reminderJob.findMany({
      orderBy: { scheduledFor: "desc" },
      include: { user: { select: { firstName: true, username: true } } },
      where: { reminderEvents: { some: { createdAt: { gte: cutoff } } } },
    }),
    prisma.$queryRaw<Array<{ hour: number; total: bigint; converted: bigint }>>`
      SELECT
        EXTRACT(HOUR FROM "sentAt" AT TIME ZONE 'UTC')::int AS hour,
        COUNT(*)::bigint AS total,
        COUNT(*) FILTER (WHERE "convertedAt" IS NOT NULL)::bigint AS converted
      FROM "ReminderJob"
      WHERE "sentAt" IS NOT NULL
        AND "sentAt" >= ${cutoff}
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
      sent: Number(reminderStats[0]?.sent ?? 0),
      skipped: Number(reminderStats[0]?.skipped ?? 0),
      snoozed: Number(reminderStats[0]?.snoozed ?? 0),
      converted: Number(reminderStats[0]?.converted ?? 0),
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
