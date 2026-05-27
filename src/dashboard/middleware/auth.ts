import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";

const TOKEN_EXPIRES_IN = "1d";

function getJwtSecret(): string {
  const secret = process.env.JWT_SECRET;
  if (!secret) {
    throw new Error("JWT_SECRET is not set");
  }
  return secret;
}

export function signDashboardToken(email: string): { token: string; expiresIn: string } {
  const token = jwt.sign({ sub: "dashboard", email }, getJwtSecret(), { expiresIn: TOKEN_EXPIRES_IN });
  return { token, expiresIn: TOKEN_EXPIRES_IN };
}

export function requireDashboardAuth(req: Request, res: Response, next: NextFunction): void {
  const authHeader = req.headers.authorization ?? "";
  if (!authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing bearer token" });
    return;
  }

  const token = authHeader.slice("Bearer ".length).trim();
  try {
    jwt.verify(token, getJwtSecret());
    next();
  } catch (err) {
    console.warn("[dashboard] Invalid token:", err);
    res.status(401).json({ error: "Invalid or expired token" });
  }
}
