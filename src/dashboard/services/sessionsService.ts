import { prisma } from "../../lib/prisma";

type SessionSummaryRow = {
  telegramId: bigint;
  latestTimestamp: Date;
  eventCount: bigint;
};

function parseMessageContent(payload: string): string {
  try {
    const parsed = JSON.parse(payload) as { text?: string; caption?: string };
    return parsed.text ?? parsed.caption ?? "";
  } catch {
    return "";
  }
}

export async function getSessions(): Promise<Array<Record<string, unknown>>> {
  const sessionsRaw = await prisma.$queryRaw<Array<SessionSummaryRow>>`
    SELECT
      "telegramId",
      MAX("timestamp") AS "latestTimestamp",
      COUNT(*)::bigint AS "eventCount"
    FROM "ReplayEvent"
    GROUP BY "telegramId"
    ORDER BY MAX("timestamp") DESC
  `;

  const telegramIds = sessionsRaw.map((s) => s.telegramId);
  const users = await prisma.user.findMany({
    where: { telegramId: { in: telegramIds } },
    select: { telegramId: true, firstName: true, username: true },
  });
  const userMap = new Map(users.map((u) => [u.telegramId.toString(), u]));

  const results: Array<Record<string, unknown>> = [];

  for (const session of sessionsRaw) {
    const userKey = session.telegramId.toString();
    const user = userMap.get(userKey);

    const events = await prisma.replayEvent.findMany({
      where: {
        telegramId: session.telegramId,
        eventType: { in: ["user_message", "bot_message"] },
      },
      orderBy: { timestamp: "asc" },
    });

    const messages = events
      .map((event) => {
        const content = parseMessageContent(event.payload);
        if (!content) return null;
        return {
          id: event.id.toString(),
          sender: event.eventType === "user_message" ? "user" : "assistant",
          content,
          timestamp: event.timestamp.toISOString(),
        };
      })
      .filter((msg): msg is { id: string; sender: string; content: string; timestamp: string } => Boolean(msg));

    const lastUserMessage = messages
      .filter((m) => m.sender === "user")
      .slice(-1)[0];

    results.push({
      summary: {
        id: `session-${userKey}`,
        userName: user?.firstName ?? "Unknown",
        username: user?.username ?? null,
        lastActive: session.latestTimestamp.toISOString(),
        totalMessages: messages.length,
        highlights: lastUserMessage?.content ?? "",
      },
      messages,
    });
  }

  return results;
}
