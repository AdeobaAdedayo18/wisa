import { prisma } from "../../lib/prisma";
import { addUtcDays, endOfUtcDay, startOfUtcDay } from "../utils/date";

function percentChange(current: number, previous: number): number {
  if (previous === 0) return current > 0 ? 100 : 0;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

function daysBetween(start: Date, end: Date): number {
  const diffMs = end.getTime() - start.getTime();
  return Math.max(0, diffMs / (24 * 60 * 60 * 1000));
}

function minorToMajor(amountMinor: number): number {
  return Math.round(amountMinor / 100);
}

function startOfUtcWeek(date: Date): Date {
  const day = date.getUTCDay();
  const diff = (day + 6) % 7; // Monday as week start
  return startOfUtcDay(addUtcDays(date, -diff));
}

export async function getPayments(): Promise<Record<string, unknown>> {
  const now = new Date();
  const monthStart = startOfUtcDay(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
  const monthEnd = endOfUtcDay(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)));
  const prevMonthStart = startOfUtcDay(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)));
  const prevMonthEnd = endOfUtcDay(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)));
  const weekStart = startOfUtcWeek(now);
  const prevWeekStart = addUtcDays(weekStart, -7);
  const prevWeekEnd = endOfUtcDay(addUtcDays(weekStart, -1));

  const transactions = await prisma.paymentTransaction.findMany({
    orderBy: { paidAt: "desc" },
    include: {
      user: { select: { firstName: true, username: true, createdAt: true } },
    },
  });

  const [totalPaidUsers, churnedUsers] = await Promise.all([
    prisma.user.count({ where: { nextRenewalDate: { not: null } } }),
    prisma.user.findMany({
      where: {
        storageUnlocked: false,
        nextRenewalDate: { not: null, lt: now },
      },
      orderBy: { nextRenewalDate: "desc" },
      include: {
        subscription: { select: { startDate: true, endDate: true, status: true } },
      },
    }),
  ]);

  const totalMinor = transactions.reduce((sum, t) => sum + t.amount, 0);
  const monthMinor = transactions
    .filter((t) => t.paidAt >= monthStart && t.paidAt <= monthEnd)
    .reduce((sum, t) => sum + t.amount, 0);
  const prevMonthMinor = transactions
    .filter((t) => t.paidAt >= prevMonthStart && t.paidAt <= prevMonthEnd)
    .reduce((sum, t) => sum + t.amount, 0);
  const weekMinor = transactions
    .filter((t) => t.paidAt >= weekStart)
    .reduce((sum, t) => sum + t.amount, 0);
  const prevWeekMinor = transactions
    .filter((t) => t.paidAt >= prevWeekStart && t.paidAt <= prevWeekEnd)
    .reduce((sum, t) => sum + t.amount, 0);

  const totalRevenue = minorToMajor(totalMinor);
  const revenueThisMonth = minorToMajor(monthMinor);
  const revenueLastMonth = minorToMajor(prevMonthMinor);
  const revenueThisWeek = minorToMajor(weekMinor);
  const revenueLastWeek = minorToMajor(prevWeekMinor);

  const avgDaysToFirstPayment = computeAvgDaysToFirstPayment(transactions);

  return {
    revenue: {
      totalRevenue,
      revenueThisMonth,
      revenueThisMonthChange: percentChange(revenueThisMonth, revenueLastMonth),
      revenueThisWeek,
      revenueThisWeekChange: percentChange(revenueThisWeek, revenueLastWeek),
      avgDaysToFirstPayment,
    },
    mrr: buildMrrSeries(transactions),
    churnRate: totalPaidUsers > 0
      ? Math.round((churnedUsers.length / totalPaidUsers) * 1000) / 10
      : 0,
    churnedUsers: churnedUsers.map((u) => {
      const planEnd = u.subscription?.endDate ?? u.nextRenewalDate;
      const planStart = u.subscription?.startDate ?? u.createdAt;
      return {
        id: u.id.toString(),
        userName: u.firstName,
        username: u.username ?? null,
        planEndDate: planEnd ? planEnd.toISOString() : null,
        logsBeforeChurn: u.logCount,
        proDays: planEnd ? Math.round(daysBetween(planStart, planEnd)) : 0,
        status: u.subscription?.status ?? "expired",
      };
    }),
    transactions: transactions.map((t) => ({
      id: t.id.toString(),
      userName: t.user.firstName,
      username: t.user.username ?? null,
      amount: minorToMajor(t.amount),
      method: t.provider,
      date: t.paidAt.toISOString(),
      status: "success",
      reference: t.reference,
      currency: t.currency,
    })),
  };
}

function buildMrrSeries(transactions: Array<{ paidAt: Date; amount: number }>): Array<{ month: string; value: number; projected?: boolean }> {
  const now = new Date();
  const monthLabel = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
  const months = [
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1)),
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)),
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
  ];

  return months.map((month, index) => {
    const nextMonth = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1));
    const totalMinor = transactions
      .filter((t) => t.paidAt >= month && t.paidAt < nextMonth)
      .reduce((sum, t) => sum + t.amount, 0);
    return {
      month: monthLabel.format(month),
      value: minorToMajor(totalMinor),
      projected: index === months.length - 1 ? true : undefined,
    };
  });
}

function computeAvgDaysToFirstPayment(
  transactions: Array<{ userId: number; paidAt: Date; user: { createdAt: Date } }>,
): number {
  if (transactions.length === 0) return 0;

  const firstPayments = new Map<number, { paidAt: Date; createdAt: Date }>();
  for (const transaction of transactions) {
    const existing = firstPayments.get(transaction.userId);
    if (!existing || transaction.paidAt < existing.paidAt) {
      firstPayments.set(transaction.userId, { paidAt: transaction.paidAt, createdAt: transaction.user.createdAt });
    }
  }

  const totals = Array.from(firstPayments.values()).reduce(
    (sum, entry) => sum + daysBetween(entry.createdAt, entry.paidAt),
    0,
  );

  return Math.round((totals / firstPayments.size) * 10) / 10;
}
