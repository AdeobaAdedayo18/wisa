import type { Request, Response } from "express";
import { getUsers } from "../services/usersService";

export async function users(req: Request, res: Response): Promise<void> {
  try {
    const data = await getUsers();
    res.json(data);
  } catch (err) {
    console.error("[dashboard] users error:", err);
    res.status(500).json({ error: "Failed to load users" });
  }
}
