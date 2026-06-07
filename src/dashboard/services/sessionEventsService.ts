import { prisma } from "../../lib/prisma";

export type EventRow = {
  id: number;
  eventType: string;
  direction: string | null;
  payload: string;
  timestamp: Date;
};

export async function getSessionEvents(options: {
  telegramId: bigint;
  page?: number;
  limit?: number;
  order?: "asc" | "desc";
  after?: string;
  before?: string;
  eventType?: string;
}) {
  const page = Math.max(1, options.page ?? 1);
  const limit = Math.min(200, options.limit ?? 150);
  const skip = (page - 1) * limit;
  const order = options.order === "desc" ? "desc" : "asc";

  const where: Record<string, unknown> = { telegramId: options.telegramId };

  if (options.after || options.before) {
    const timestampFilter: Record<string, Date> = {};
    if (options.after) timestampFilter.gte = new Date(options.after);
    if (options.before) timestampFilter.lte = new Date(options.before);
    where.timestamp = timestampFilter;
  }

  if (options.eventType) where.eventType = options.eventType;

  const [events, total] = await Promise.all([
    prisma.replayEvent.findMany({
      where,
      skip,
      take: limit,
      orderBy: { timestamp: order as "asc" | "desc" },
    }),
    prisma.replayEvent.count({ where }),
  ]);

  const parsed = events.map((e) => {
    let parsedPayload: unknown;
    try {
      parsedPayload = JSON.parse(e.payload);
    } catch {
      parsedPayload = { raw: e.payload };
    }
    return {
      id: e.id,
      eventType: e.eventType,
      direction: e.direction,
      payload: parsedPayload,
      timestamp: e.timestamp,
    };
  });

  return { data: parsed, total, page, pages: Math.ceil(total / limit) };
}
