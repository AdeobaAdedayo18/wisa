import { prisma } from "../../lib/prisma";
import { formatDateUtc } from "../utils/date";

function buildPreview(content: string, maxLen = 140): string {
  if (content.length <= maxLen) return content;
  return `${content.slice(0, maxLen)}...`;
}

export async function getUsers(): Promise<Array<Record<string, unknown>>> {
  const [users, reminderStats] = await Promise.all([
    prisma.user.findMany({
      orderBy: { createdAt: "desc" },
      include: {
        logs: { take: 10, orderBy: { logDate: "desc" } },
        subscription: { select: { status: true } },
      },
    }),
    prisma.$queryRaw<Array<{ userId: number; received: bigint; skipped: bigint; acted_on: bigint }>>`
      SELECT
        "userId",
        COUNT(*) FILTER (WHERE status IN ('sent', 'snoozed', 'skipped'))::bigint AS received,
        COUNT(*) FILTER (WHERE status = 'skipped')::bigint AS skipped,
        COUNT(*) FILTER (WHERE "convertedAt" IS NOT NULL)::bigint AS acted_on
      FROM "ReminderJob"
      GROUP BY "userId"
    `,
  ]);

  const reminderMap = new Map(
    reminderStats.map((row) => [row.userId, { received: Number(row.received), skipped: Number(row.skipped), actedOn: Number(row.acted_on) }]),
  );

  return users.map((user) => {
    const plan = user.subscription?.status === "active" || user.isPro || user.storageUnlocked ? "pro" : "free";
    const reminder = reminderMap.get(user.id) ?? { received: 0, skipped: 0, actedOn: 0 };

    return {
      id: user.id.toString(),
      name: user.firstName,
      username: user.username ?? null,
      telegramId: user.telegramId.toString(),
      plan,
      logs: user.logCount,
      onboarded: user.onboardingDone,
      lastActive: user.logs[0]?.logDate ? formatDateUtc(user.logs[0].logDate) : null,
      joined: formatDateUtc(user.createdAt),
      hitPaywall: user.hitPaywall,
      reminderStats: reminder,
      recentLogs: user.logs.map((log) => ({
        id: log.id.toString(),
        date: formatDateUtc(log.logDate),
        type: log.isVoice ? "voice" : "text",
        preview: buildPreview(log.refinedContent ?? log.content),
        refined: log.isAiRefined,
        content: log.refinedContent ?? log.content,
      })),
    };
  });
}
