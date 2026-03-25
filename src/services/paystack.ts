import axios from "axios";
import { STORAGE_PLAN_AMOUNT_KOBO } from "../utils/constants";

const PAYSTACK_BASE = "https://api.paystack.co";
const headers = { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` };

export async function initializeTransaction(telegramId: bigint, email: string) {
  const res = await axios.post(
    `${PAYSTACK_BASE}/transaction/initialize`,
    {
      amount: STORAGE_PLAN_AMOUNT_KOBO,
      email,
      metadata: { telegramId: telegramId.toString() },
    },
    { headers }
  );
  return res.data.data as { authorization_url: string; reference: string };
}

export async function verifyTransaction(reference: string) {
  const res = await axios.get(
    `${PAYSTACK_BASE}/transaction/verify/${encodeURIComponent(reference)}`,
    { headers }
  );
  return res.data.data as {
    status: string;              // "success" | "failed" | "abandoned"
    reference: string;
    amount: number;
    metadata: { telegramId?: string };
    customer: { email: string };
  };
}
