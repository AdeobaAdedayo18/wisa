import type { Request, Response } from "express";
import { getReminders } from "../services/remindersService";

export async function reminders(req: Request, res: Response): Promise<void> {
  try {
    const data = await getReminders();
    res.json(data);
  } catch (err) {
    console.error("[dashboard] reminders error:", err);
    res.status(500).json({ error: "Failed to load reminders" });
  }
}
