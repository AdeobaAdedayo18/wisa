import type { Request, Response } from "express";
import { loginDashboard } from "../services/authService";

export function login(req: Request, res: Response): void {
  try {
    const email = String(req.body?.email ?? "").trim();
    const password = String(req.body?.password ?? "").trim();

    if (!email || !password) {
      res.status(400).json({ error: "Email and password are required" });
      return;
    }

    const { token, expiresIn } = loginDashboard(email, password);
    res.json({ token, tokenType: "Bearer", expiresIn });
  } catch (err) {
    const message = err instanceof Error ? err.message : "Login failed";
    const status = message === "Invalid credentials" ? 401 : 500;
    res.status(status).json({ error: message });
  }
}
