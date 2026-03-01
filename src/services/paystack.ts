import axios from "axios";

const PAYSTACK_BASE = "https://api.paystack.co";
const headers = { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` };

export async function initializeTransaction(telegramId: bigint) {
  const res = await axios.post(
    `${PAYSTACK_BASE}/transaction/initialize`,
    {
      amount: 500000, // ₦5,000 in kobo
      email: `${telegramId}@wisa.app`,
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
