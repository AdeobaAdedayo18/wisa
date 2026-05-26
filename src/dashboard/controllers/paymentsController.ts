import type { Request, Response } from "express";
import { getPayments } from "../services/paymentsService";

export async function payments(req: Request, res: Response): Promise<void> {
  try {
    const data = await getPayments();
    res.json(data);
  } catch (err) {
    console.error("[dashboard] payments error:", err);
    res.status(500).json({ error: "Failed to load payments" });
  }
}
