import type { Request, Response } from "express";
import { getCampaigns } from "../services/campaignsService";

export async function campaigns(req: Request, res: Response): Promise<void> {
  try {
    const data = await getCampaigns();
    res.json(data);
  } catch (err) {
    console.error("[dashboard] campaigns error:", err);
    res.status(500).json({ error: "Failed to load campaigns" });
  }
}
