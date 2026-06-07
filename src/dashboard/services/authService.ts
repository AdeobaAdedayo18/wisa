import { signDashboardToken } from "../middleware/auth";

export function loginDashboard(email: string, password: string): { token: string; expiresIn: string } {
  const adminUser = process.env.ADMIN_USER ?? "admin";
  const adminPass = process.env.ADMIN_PASSWORD;

  if (!adminPass) {
    throw new Error("ADMIN_PASSWORD is not set");
  }

  if (email !== adminUser || password !== adminPass) {
    throw new Error("Invalid credentials");
  }

  return signDashboardToken(email);
}
