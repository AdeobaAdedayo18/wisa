import { prisma } from "../../lib/prisma";
import { addUtcDays, buildUtcDaySeries, endOfUtcDay, startOfUtcDay } from "../utils/date";

const SPARKLINE_DAYS = 7;
const SERIES_DAYS = 30;

function formatCount(count: number): string {
  return count.toLocaleString("en-US");
}

function formatDelta(count: number, label: string): string {
  const sign = count >= 0 ? "+" : "";
  return `${sign}${count} ${label}`;
}

function computeTrend(current: number, previous: number): { trend: "up" | "down" | "neutral"; trendValue: number } {
  if (previous <= 0 && current <= 0) return { trend: "neutral", trendValue: 0 };
  if (previous <= 0) return { trend: "up", trendValue: 100 };
  const change = ((current - previous) / previous) * 100;
  if (Math.abs(change) < 0.5) return { trend: "neutral", trendValue: 0 };
  return { trend: change > 0 ? "up" : "down", trendValue: Math.round(change * 10) / 10 };
}

async function countDistinctUsersWithLogs(start?: Date): Promise<number> {
  const rows = start
    ? await prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(DISTINCT "userId")::bigint AS count
        FROM "Log"
        WHERE "logDate" >= ${start}
      `
    : await prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(DISTINCT "userId")::bigint AS count
        FROM "Log"
      `;
  return Number(rows[0]?.count ?? 0);
}

export async function getOverview(): Promise<Record<string, unknown>> {
  const now = new Date();
  const todayStart = startOfUtcDay(now);
  const todayEnd = endOfUtcDay(now);
  const weekStart = startOfUtcDay(addUtcDays(now, -7));
  const prevWeekStart = startOfUtcDay(addUtcDays(now, -14));
  const prevWeekEnd = endOfUtcDay(addUtcDays(now, -8));

  const [
    totalUsers,
    onboardedUsers,
    totalLogs,
    payingUsers,
    newUsersToday,
    newUsersThisWeek,
    newUsersPrevWeek,
    logsToday,
    logsThisWeek,
    logsPrevWeek,
    usersWithLogs,
    usersLoggedThisWeek,
  ] = await Promise.all([
    prisma.user.count(),
    prisma.user.count({ where: { onboardingDone: true } }),
    prisma.log.count(),
    prisma.subscription.count({ where: { status: "active" } }),
    prisma.user.count({ where: { createdAt: { gte: todayStart, lte: todayEnd } } }),
    prisma.user.count({ where: { createdAt: { gte: weekStart, lte: todayEnd } } }),
    prisma.user.count({ where: { createdAt: { gte: prevWeekStart, lte: prevWeekEnd } } }),
    prisma.log.count({ where: { logDate: { gte: todayStart, lte: todayEnd } } }),
    prisma.log.count({ where: { logDate: { gte: weekStart, lte: todayEnd } } }),
    prisma.log.count({ where: { logDate: { gte: prevWeekStart, lte: prevWeekEnd } } }),
    countDistinctUsersWithLogs(),
    countDistinctUsersWithLogs(weekStart),
  ]);

  const userSeries = buildUtcDaySeries(SERIES_DAYS, now);
  const logSeries = buildUtcDaySeries(SERIES_DAYS, now);
  const sparkSeries = buildUtcDaySeries(SPARKLINE_DAYS, now);

  const [userGrowth, logsWritten, userSparkline, logSparkline] = await Promise.all([
    Promise.all(
      userSeries.map(async (d) => ({
        date: d.date,
        value: await prisma.user.count({ where: { createdAt: { gte: d.start, lte: d.end } } }),
      })),
    ),
    Promise.all(
      logSeries.map(async (d) => ({
        date: d.date,
        value: await prisma.log.count({ where: { logDate: { gte: d.start, lte: d.end } } }),
      })),
    ),
    Promise.all(
      sparkSeries.map(async (d, index) => ({
        index,
        value: await prisma.user.count({ where: { createdAt: { gte: d.start, lte: d.end } } }),
      })),
    ),
    Promise.all(
      sparkSeries.map(async (d, index) => ({
        index,
        value: await prisma.log.count({ where: { logDate: { gte: d.start, lte: d.end } } }),
      })),
    ),
  ]);

  const funnel = [
    { label: "Joined", count: totalUsers },
    { label: "Onboarded", count: onboardedUsers },
    { label: "Wrote first log", count: usersWithLogs },
    { label: "Logged this week", count: usersLoggedThisWeek },
    { label: "Paying", count: payingUsers },
  ];

  const userTrend = computeTrend(newUsersThisWeek, newUsersPrevWeek);
  const logTrend = computeTrend(logsThisWeek, logsPrevWeek);

  const stats = [
    {
      title: "Total Users",
      value: formatCount(totalUsers),
      todayDelta: formatDelta(newUsersToday, "today"),
      weekDelta: formatDelta(newUsersThisWeek, "this week"),
      trend: userTrend.trend,
      trendValue: userTrend.trendValue,
      sparklineData: userSparkline,
      tooltip: "Total registered users in Wisa.",
      subtitle: "",
    },
    {
      title: "Logs Written",
      value: formatCount(totalLogs),
      todayDelta: formatDelta(logsToday, "today"),
      weekDelta: formatDelta(logsThisWeek, "this week"),
      trend: logTrend.trend,
      trendValue: logTrend.trendValue,
      sparklineData: logSparkline,
      tooltip: "All logs written by users.",
      subtitle: "",
    },
    {
      title: "Paying Users",
      value: formatCount(payingUsers),
      todayDelta: formatDelta(0, "today"),
      weekDelta: formatDelta(0, "this week"),
      trend: "neutral",
      trendValue: 0,
      sparklineData: [],
      tooltip: "Users with an active subscription.",
      subtitle: "",
    },
    {
      title: "Onboarded Users",
      value: formatCount(onboardedUsers),
      todayDelta: formatDelta(0, "today"),
      weekDelta: formatDelta(0, "this week"),
      trend: "neutral",
      trendValue: 0,
      sparklineData: [],
      tooltip: "Users who completed onboarding.",
      subtitle: "",
    },
  ];

  const paretoShare = await computeParetoShare(totalLogs);
  const avgLogsPerUser = totalUsers > 0 ? Math.round((totalLogs / totalUsers) * 10) / 10 : 0;
  const avgTimeToFirstLogHours = await computeAvgTimeToFirstLogHours();
  const avgTimeToFirstLogTrend = await computeAvgTimeToFirstLogTrendHours();
  const inactiveBreakdown = await computeInactiveBreakdown(now);
  const { paywallNonPaymentRate, paywallNonPaymentCount } = await computePaywallNonPayment();

  return {
    funnel,
    stats,
    userGrowth,
    logsWritten,
    insights: {
      paretoShare,
      avgLogsPerUser,
      avgTimeToFirstLogHours,
      avgTimeToFirstLogTrend,
      inactiveBreakdown,
      paywallNonPaymentRate,
      paywallNonPaymentCount,
    },
  };
}

async function computeParetoShare(totalLogs: number): Promise<number> {
  if (totalLogs === 0) return 0;
  const logGroups = await prisma.log.groupBy({
    by: ["userId"],
    _count: { _all: true },
  });
  const sorted = logGroups
    .map((g) => g._count._all)
    .sort((a, b) => b - a);
  if (sorted.length === 0) return 0;
  const topCount = Math.max(1, Math.ceil(sorted.length * 0.2));
  const topLogs = sorted.slice(0, topCount).reduce((sum, v) => sum + v, 0);
  return Math.round((topLogs / totalLogs) * 100);
}

async function computeAvgTimeToFirstLogHours(): Promise<number> {
  const rows = await prisma.$queryRaw<Array<{ avg_hours: number | null }>>`
    SELECT AVG(EXTRACT(EPOCH FROM (first_log."logDate" - u."createdAt")) / 3600.0) AS avg_hours
    FROM "User" u
    JOIN LATERAL (
      SELECT MIN(l."logDate") AS "logDate"
      FROM "Log" l
      WHERE l."userId" = u.id
    ) first_log ON first_log."logDate" IS NOT NULL
  `;
  const avg = rows[0]?.avg_hours ?? 0;
  return Math.round(avg * 10) / 10;
}

async function computeAvgTimeToFirstLogTrendHours(): Promise<number> {
  const now = new Date();
  const currentStart = startOfUtcDay(addUtcDays(now, -7));
  const previousStart = startOfUtcDay(addUtcDays(now, -14));
  const previousEnd = endOfUtcDay(addUtcDays(now, -8));

  const [currentRows, prevRows] = await Promise.all([
    prisma.$queryRaw<Array<{ avg_hours: number | null }>>`
      SELECT AVG(EXTRACT(EPOCH FROM (first_log."logDate" - u."createdAt")) / 3600.0) AS avg_hours
      FROM "User" u
      JOIN LATERAL (
        SELECT MIN(l."logDate") AS "logDate"
        FROM "Log" l
        WHERE l."userId" = u.id
      ) first_log ON first_log."logDate" IS NOT NULL
      WHERE u."createdAt" >= ${currentStart}
    `,
    prisma.$queryRaw<Array<{ avg_hours: number | null }>>`
      SELECT AVG(EXTRACT(EPOCH FROM (first_log."logDate" - u."createdAt")) / 3600.0) AS avg_hours
      FROM "User" u
      JOIN LATERAL (
        SELECT MIN(l."logDate") AS "logDate"
        FROM "Log" l
        WHERE l."userId" = u.id
      ) first_log ON first_log."logDate" IS NOT NULL
      WHERE u."createdAt" >= ${previousStart} AND u."createdAt" <= ${previousEnd}
    `,
  ]);

  const current = currentRows[0]?.avg_hours ?? 0;
  const previous = prevRows[0]?.avg_hours ?? 0;
  const delta = Math.round((current - previous) * 10) / 10;
  return Number.isFinite(delta) ? delta : 0;
}

async function computeInactiveBreakdown(now: Date): Promise<{ oneToTwoWeeks: number; twoToFourWeeks: number; fourPlusWeeks: number }> {
  const rows = await prisma.$queryRaw<Array<{ last_activity: Date }>>`
    SELECT COALESCE(MAX(l."logDate"), u."createdAt") AS last_activity
    FROM "User" u
    LEFT JOIN "Log" l ON l."userId" = u.id
    GROUP BY u.id, u."createdAt"
  `;

  let oneToTwoWeeks = 0;
  let twoToFourWeeks = 0;
  let fourPlusWeeks = 0;

  rows.forEach((row) => {
    const diffMs = now.getTime() - new Date(row.last_activity).getTime();
    const diffDays = diffMs / (24 * 60 * 60 * 1000);
    if (diffDays > 7 && diffDays <= 14) {
      oneToTwoWeeks += 1;
    } else if (diffDays > 14 && diffDays <= 28) {
      twoToFourWeeks += 1;
    } else if (diffDays > 28) {
      fourPlusWeeks += 1;
    }
  });

  return { oneToTwoWeeks, twoToFourWeeks, fourPlusWeeks };
}

async function computePaywallNonPayment(): Promise<{ paywallNonPaymentRate: number; paywallNonPaymentCount: number }> {
  const [hitPaywall, nonPaying] = await Promise.all([
    prisma.user.count({ where: { hitPaywall: true } }),
    prisma.user.count({ where: { hitPaywall: true, storageUnlocked: false } }),
  ]);

  const rate = hitPaywall > 0 ? Math.round((nonPaying / hitPaywall) * 100) : 0;
  return { paywallNonPaymentRate: rate, paywallNonPaymentCount: nonPaying };
}
