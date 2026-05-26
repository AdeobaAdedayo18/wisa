import type { Request, Response } from "express";
import { getSessions } from "../services/sessionsService";

export async function sessions(req: Request, res: Response): Promise<void> {
  try {
    const data = await getSessions();
    res.json(data);
  } catch (err) {
    console.error("[dashboard] sessions error:", err);
    res.status(500).json({ error: "Failed to load sessions" });
  }
}
