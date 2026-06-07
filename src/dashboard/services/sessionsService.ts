import { prisma } from "../../lib/prisma";

// Return the same summary shape the frontend currently expects (but without embedding
// the full messages). A separate endpoint will expose the full event list in the
// same shape as /admin/api/replay/events/:telegramId.
export async function getSessions(): Promise<Array<Record<string, unknown>>> {
  // Query latest timestamp, event counts and error counts per telegramId
  const sessionsRaw: Array<{
    telegramId: bigint;
    latestTimestamp: Date;
    eventCount: bigint;
    errorCount: bigint;
  }> = await prisma.$queryRaw`
    SELECT
      "telegramId",
      MAX("timestamp") AS "latestTimestamp",
      COUNT(*)::bigint AS "eventCount",
      COUNT(*) FILTER (WHERE "eventType" = 'error')::bigint AS "errorCount"
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

  // Get a preview (latest event payload summary) for each telegramId
  const previews = await Promise.all(
    telegramIds.map(async (tid) => {
      const latest = await prisma.replayEvent.findFirst({
        where: { telegramId: tid },
        orderBy: { timestamp: "desc" },
        select: { eventType: true, payload: true },
      });
      if (!latest) return { tid: tid.toString(), preview: "" };

      try {
        const p = JSON.parse(latest.payload as unknown as string);
        let preview = "";
        switch (latest.eventType) {
          case "user_message":
          case "bot_message":
            preview = (p.text ?? p.caption ?? "").toString().slice(0, 80);
            break;
          case "user_callback":
            preview = `Tapped: ${p.buttonLabel ?? p.data}`;
            break;
          case "error":
            preview = `⚠️ ${p.errorMessage?.toString().slice(0, 60)}`;
            break;
          default:
            preview = latest.eventType;
        }
        return { tid: tid.toString(), preview };
      } catch {
        return { tid: tid.toString(), preview: latest.eventType };
      }
    }),
  );
  const previewMap = new Map(previews.map((p) => [p.tid, p.preview]));

  const results = sessionsRaw.map((s) => {
    const user = userMap.get(s.telegramId.toString());
    return {
      summary: {
        id: `session-${s.telegramId.toString()}`,
        telegramId: s.telegramId.toString(),
        userName: user?.firstName ?? "Unknown",
        username: user?.username ?? null,
        lastActive: s.latestTimestamp.toISOString(),
        totalMessages: Number(s.eventCount),
        highlights: previewMap.get(s.telegramId.toString()) ?? "",
      },
    };
  });

  return results;
}
