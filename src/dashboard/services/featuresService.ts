import { prisma } from "../../lib/prisma";
import { buildUtcDaySeries } from "../utils/date";

const SERIES_DAYS = 30;

type FeatureCategory = "messaging" | "ai-refinement" | "catch-up";

export async function getFeatureAnalytics(category: FeatureCategory): Promise<Record<string, unknown>> {
  const now = new Date();
  const series = buildUtcDaySeries(SERIES_DAYS, now);

  if (category === "messaging") {
    const [sent, converted, timeline] = await Promise.all([
      prisma.reminderJob.count({ where: { status: "sent" } }),
      prisma.reminderJob.count({ where: { convertedAt: { not: null } } }),
      Promise.all(
        series.map(async (d) => ({
          date: d.date,
          value: await prisma.reminderJob.count({ where: { convertedAt: { gte: d.start, lte: d.end } } }),
        })),
      ),
    ]);

    const rate = sent > 0 ? Math.round((converted / sent) * 100) : 0;

    return {
      category,
      metrics: [{ label: "Prompt completion rate", value: `${rate}%`, trend: 0 }],
      insights: [{ title: "Best prompt window", description: "Based on reminders sent in the last 30 days." }],
      timeline,
    };
  }

  if (category === "ai-refinement") {
    const [total, refined, timeline] = await Promise.all([
      prisma.log.count(),
      prisma.log.count({ where: { isAiRefined: true } }),
      Promise.all(
        series.map(async (d) => ({
          date: d.date,
          value: await prisma.log.count({ where: { isAiRefined: true, logDate: { gte: d.start, lte: d.end } } }),
        })),
      ),
    ]);

    const share = total > 0 ? Math.round((refined / total) * 100) : 0;

    return {
      category,
      metrics: [{ label: "AI refinement share", value: `${share}%`, trend: 0 }],
      insights: [{ title: "Refinement usage", description: "AI refinements as a share of total logs." }],
      timeline,
    };
  }

  const [catchupRows, totalLogs] = await Promise.all([
    prisma.$queryRaw<Array<{ count: bigint }>>`
      SELECT COUNT(*)::bigint AS count
      FROM "Log"
      WHERE "createdAt" > "logDate"
    `,
    prisma.log.count(),
  ]);

  const catchupLogs = Number(catchupRows[0]?.count ?? 0);
  const catchupShare = totalLogs > 0 ? Math.round((catchupLogs / totalLogs) * 100) : 0;

  const timeline = await Promise.all(
    series.map(async (d) => {
      const rows = await prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*)::bigint AS count
        FROM "Log"
        WHERE "createdAt" >= ${d.start}
          AND "createdAt" <= ${d.end}
          AND "createdAt" > "logDate"
      `;
      return { date: d.date, value: Number(rows[0]?.count ?? 0) };
    }),
  );

  return {
    category,
    metrics: [{ label: "Catch-up share", value: `${catchupShare}%`, trend: 0 }],
    insights: [{ title: "Catch-up activity", description: "Logs created after their intended date." }],
    timeline,
  };
}
