import { prisma } from "../../lib/prisma";
import { formatDateUtc } from "../utils/date";

function buildPreview(content: string, maxLen = 140): string {
  if (content.length <= maxLen) return content;
  return `${content.slice(0, maxLen)}...`;
}

export async function getLogs(): Promise<Array<Record<string, unknown>>> {
  const logs = await prisma.log.findMany({
    orderBy: { logDate: "desc" },
    include: { user: { select: { firstName: true, username: true, telegramId: true } } },
  });

  return logs.map((log) => ({
    id: log.id.toString(),
    userId: log.userId.toString(),
    userName: log.user.firstName,
    username: log.user.username ?? null,
    telegramId: log.user.telegramId.toString(),
    createdAt: formatDateUtc(log.createdAt),
    submittedFor: formatDateUtc(log.logDate),
    type: log.isVoice ? "voice" : "text",
    preview: buildPreview(log.refinedContent ?? log.content),
    refined: log.isAiRefined,
    originalContent: log.content,
    refinedContent: log.refinedContent ?? null,
  }));
}
