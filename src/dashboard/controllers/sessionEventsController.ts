import type { Request, Response } from "express";
import { getSessionEvents } from "../services/sessionEventsService";

function parseTelegramIdParam(value: string): bigint {
  const normalized = value.startsWith("session-") ? value.slice("session-".length) : value;
  if (!/^\d+$/.test(normalized)) {
    throw new RangeError("Invalid telegramId");
  }
  return BigInt(normalized);
}

export async function sessionEvents(req: Request, res: Response): Promise<void> {
  try {
    const telegramId = parseTelegramIdParam(String(req.params.telegramId));
    const page = Math.max(1, parseInt(String(req.query.page ?? "1"), 10));
    const limit = Math.min(200, Math.max(1, parseInt(String(req.query.limit ?? "150"), 10)));
    const order = String(req.query.order ?? "asc") as "asc" | "desc";
    const after = String(req.query.after ?? "");
    const before = String(req.query.before ?? "");
    const eventType = String(req.query.eventType ?? "");

    const result = await getSessionEvents({
      telegramId,
      page,
      limit,
      order,
      after: after || undefined,
      before: before || undefined,
      eventType: eventType || undefined,
    });

    res.json(result);
  } catch (err) {
    if (err instanceof RangeError) {
      res.status(400).json({ error: "Invalid telegramId" });
      return;
    }
    console.error("[dashboard] session events error:", err);
    res.status(500).json({ error: "Failed to load session events" });
  }
}
