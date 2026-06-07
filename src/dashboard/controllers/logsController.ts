import type { Request, Response } from "express";
import { getLogs } from "../services/logsService";

export async function logs(req: Request, res: Response): Promise<void> {
  try {
    const data = await getLogs();
    res.json(data);
  } catch (err) {
    console.error("[dashboard] logs error:", err);
    res.status(500).json({ error: "Failed to load logs" });
  }
}
