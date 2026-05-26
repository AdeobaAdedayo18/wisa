import type { Request, Response } from "express";
import { getOverview } from "../services/overviewService";

export async function overview(req: Request, res: Response): Promise<void> {
  try {
    const data = await getOverview();
    res.json(data);
  } catch (err) {
    console.error("[dashboard] overview error:", err);
    res.status(500).json({ error: "Failed to load overview" });
  }
}
