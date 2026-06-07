import type { Request, Response } from "express";
import { getFeatureAnalytics } from "../services/featuresService";

export async function features(req: Request, res: Response): Promise<void> {
  try {
    const category = String(req.query.category ?? "messaging");
    if (!["messaging", "ai-refinement", "catch-up"].includes(category)) {
      res.status(400).json({ error: "Invalid category" });
      return;
    }

    const data = await getFeatureAnalytics(category as "messaging" | "ai-refinement" | "catch-up");
    res.json(data);
  } catch (err) {
    console.error("[dashboard] features error:", err);
    res.status(500).json({ error: "Failed to load feature analytics" });
  }
}
