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
      plan: process.env.PAYSTACK_PRO_PLAN_CODE, 
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

/**
 * Fetches a user's active subscriptions by email and disables them.
 */
export async function disableSubscription(email: string) {
  try {
    // 1. Find the user's active subscriptions
    const subRes = await axios.get(
      `${PAYSTACK_BASE}/subscription?email=${encodeURIComponent(email)}`,
      { headers }
    );
    
    const subscriptions = subRes.data.data;
    
    if (!subscriptions || subscriptions.length === 0) {
      console.log(`[paystack] No active subscriptions found for ${email}`);
      return;
    }

    
    for (const sub of subscriptions) {
      if (sub.status === "active") {
        await axios.post(
          `${PAYSTACK_BASE}/subscription/disable`,
          {
            code: sub.subscription_code,
            token: sub.email_token,
          },
          { headers }
        );
        console.log(`[paystack] Successfully disabled subscription for ${email}`);
      }
    }
  } catch (error: any) {
    console.error("[paystack] Failed to disable subscription:", error.response?.data || error.message);
    throw error;
  }
}