import { prisma } from "../../lib/prisma";
import { addUtcDays, endOfUtcDay, startOfUtcDay } from "../utils/date";

const STORAGE_PRICE_NGN = 1000;

function percentChange(current: number, previous: number): number {
  if (previous === 0) return current > 0 ? 100 : 0;
  return Math.round(((current - previous) / previous) * 1000) / 10;
}

function daysBetween(start: Date, end: Date): number {
  const diffMs = end.getTime() - start.getTime();
  return Math.max(0, diffMs / (24 * 60 * 60 * 1000));
}

export async function getPayments(): Promise<Record<string, unknown>> {
  const now = new Date();
  const monthStart = startOfUtcDay(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)));
  const monthEnd = endOfUtcDay(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 0)));
  const prevMonthStart = startOfUtcDay(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)));
  const prevMonthEnd = endOfUtcDay(new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 0)));
  const weekStart = startOfUtcDay(addUtcDays(now, -7));
  const prevWeekStart = startOfUtcDay(addUtcDays(now, -14));
  const prevWeekEnd = endOfUtcDay(addUtcDays(now, -8));

  const subscriptions = await prisma.subscription.findMany({
    orderBy: { startDate: "desc" },
    include: {
      user: { select: { firstName: true, username: true, logCount: true, createdAt: true } },
    },
  });

  const totalRevenue = subscriptions.length * STORAGE_PRICE_NGN;
  const revenueThisMonth = subscriptions.filter((s) => s.startDate >= monthStart && s.startDate <= monthEnd).length * STORAGE_PRICE_NGN;
  const revenueLastMonth = subscriptions.filter((s) => s.startDate >= prevMonthStart && s.startDate <= prevMonthEnd).length * STORAGE_PRICE_NGN;
  const revenueThisWeek = subscriptions.filter((s) => s.startDate >= weekStart).length * STORAGE_PRICE_NGN;
  const revenueLastWeek = subscriptions.filter((s) => s.startDate >= prevWeekStart && s.startDate <= prevWeekEnd).length * STORAGE_PRICE_NGN;

  const churned = subscriptions.filter((s) => s.status === "cancelled" || s.status === "expired");
  const churnRate = subscriptions.length > 0 ? Math.round((churned.length / subscriptions.length) * 1000) / 10 : 0;

  const avgDaysToFirstPayment = computeAvgDaysToFirstPayment(subscriptions);

  return {
    revenue: {
      totalRevenue,
      revenueThisMonth,
      revenueThisMonthChange: percentChange(revenueThisMonth, revenueLastMonth),
      revenueThisWeek,
      revenueThisWeekChange: percentChange(revenueThisWeek, revenueLastWeek),
      avgDaysToFirstPayment,
    },
    mrr: buildMrrSeries(subscriptions),
    churnRate,
    churnedUsers: churned.map((s) => ({
      id: s.id.toString(),
      userName: s.user.firstName,
      username: s.user.username ?? null,
      planEndDate: s.endDate.toISOString(),
      logsBeforeChurn: s.user.logCount,
      proDays: Math.round(daysBetween(s.startDate, s.endDate)),
    })),
    transactions: subscriptions.map((s) => ({
      id: s.id.toString(),
      userName: s.user.firstName,
      username: s.user.username ?? null,
      amount: STORAGE_PRICE_NGN,
      method: "paystack",
      date: s.startDate.toISOString(),
      status: s.status,
    })),
  };
}

function buildMrrSeries(subscriptions: Array<{ startDate: Date }>): Array<{ month: string; value: number; projected?: boolean }> {
  const now = new Date();
  const monthLabel = new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric", timeZone: "UTC" });
  const months = [
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 2, 1)),
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1)),
    new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)),
  ];

  return months.map((month, index) => {
    const nextMonth = new Date(Date.UTC(month.getUTCFullYear(), month.getUTCMonth() + 1, 1));
    const count = subscriptions.filter((s) => s.startDate >= month && s.startDate < nextMonth).length;
    return {
      month: monthLabel.format(month),
      value: count * STORAGE_PRICE_NGN,
      projected: index === months.length - 1 ? true : undefined,
    };
  });
}

function computeAvgDaysToFirstPayment(subscriptions: Array<{ startDate: Date; user: { createdAt: Date } }>): number {
  if (subscriptions.length === 0) return 0;
  const total = subscriptions.reduce((sum, sub) => sum + daysBetween(sub.user.createdAt, sub.startDate), 0);
  return Math.round((total / subscriptions.length) * 10) / 10;
}
