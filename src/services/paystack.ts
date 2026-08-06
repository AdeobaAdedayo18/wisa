import axios from "axios";
import crypto from "crypto";
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

export async function initializeCatchupPassTransaction(
  email: string,
  amount: number,
  catchupSessionId: string,
) {
  const res = await axios.post(
    `${PAYSTACK_BASE}/transaction/initialize`,
    {
      amount,
      email,
      metadata: {
        custom_fields: [
          { variable_name: "payment_type", value: "rescue_pass" },
          { variable_name: "catchup_session_id", value: catchupSessionId },
        ],
      },
    },
    { headers },
  );

  return res.data.data as { authorization_url: string; reference: string };
}

export const RESCUE_PASS_PAYMENT_TYPE = "rescue_pass";

/**
 * Verifies a Paystack webhook body against the `x-paystack-signature` header.
 *
 * Constant-time: a plain `!==` on the hex digests short-circuits at the first
 * differing byte and leaks how much of a forged signature was correct. Call this
 * BEFORE parsing the body — nothing unauthenticated should reach a parser.
 */
export function hasValidPaystackSignature(rawBody: string, signature: unknown): boolean {
  const secret = process.env.PAYSTACK_WEBHOOK_SECRET;
  if (!secret || typeof signature !== "string" || signature.length === 0) return false;

  const expected = crypto.createHmac("sha512", secret).update(rawBody).digest();

  let provided: Buffer;
  try {
    provided = Buffer.from(signature, "hex");
  } catch {
    return false;
  }

  // timingSafeEqual throws on a length mismatch, so check it first.
  if (provided.length !== expected.length) return false;

  return crypto.timingSafeEqual(expected, provided);
}

type PaystackMetadata = {
  telegramId?: string;
  custom_fields?: Array<{ variable_name?: string; value?: string }>;
} | null | undefined;

/** Reads a single Paystack `metadata.custom_fields` entry by variable name. */
export function readPaystackCustomField(metadata: unknown, variableName: string): string | undefined {
  const fields = (metadata as PaystackMetadata)?.custom_fields;
  if (!Array.isArray(fields)) return undefined;
  const match = fields.find((field) => field?.variable_name === variableName);
  return typeof match?.value === "string" ? match.value : undefined;
}

/** True when this charge is a SIWES Rescue Pass rather than a storage subscription. */
export function isRescuePassPayment(metadata: unknown): boolean {
  return readPaystackCustomField(metadata, "payment_type") === RESCUE_PASS_PAYMENT_TYPE;
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
    currency?: string;
    metadata: {
      telegramId?: string;
      custom_fields?: Array<{ variable_name: string; value: string }>;
    };
    customer: { email: string };
    paid_at?: string;
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

type SubscriptionIdentity = {
  subscriptionCode: string;
  customerCode: string | undefined;
  status: string;
};

function subscriptionRecency(sub: any): number {
  const created = Date.parse(sub?.createdAt ?? sub?.created_at ?? "");
  if (!Number.isNaN(created)) return created;
  return typeof sub?.id === "number" ? sub.id : 0;
}

async function listActiveSubscriptions(email: string): Promise<Array<any>> {
  const res = await axios.get(
    `${PAYSTACK_BASE}/subscription?email=${encodeURIComponent(email)}`,
    { headers }
  );
  const subs = (res.data?.data ?? []) as Array<any>;
  return subs.filter((s) => s.status === "active");
}

async function fetchSubscriptionEmailToken(code: string): Promise<string | undefined> {
  const res = await axios.get(
    `${PAYSTACK_BASE}/subscription/${encodeURIComponent(code)}`,
    { headers }
  );
  return res.data?.data?.email_token as string | undefined;
}

async function disableSubscriptionByCode(code: string, emailToken: string): Promise<void> {
  await axios.post(
    `${PAYSTACK_BASE}/subscription/disable`,
    { code, token: emailToken },
    { headers }
  );
}

export async function collapseToOneSubscription(
  email: string,
  incoming: SubscriptionIdentity,
): Promise<SubscriptionIdentity> {
  const active = await listActiveSubscriptions(email);
  if (active.length <= 1) return incoming;

  const keeper = active.reduce((newest, s) =>
    subscriptionRecency(s) > subscriptionRecency(newest) ? s : newest,
  );

  for (const sub of active) {
    if (sub.subscription_code === keeper.subscription_code) continue;
    try {
      const token = sub.email_token ?? (await fetchSubscriptionEmailToken(sub.subscription_code));
      if (!token) {
        console.warn(`[paystack] Cannot disable ${sub.subscription_code} for ${email} — no email_token`);
        continue;
      }
      await disableSubscriptionByCode(sub.subscription_code, token);
      console.log(`[paystack] Disabled duplicate subscription ${sub.subscription_code} for ${email}`);
    } catch (err: any) {
      console.error(`[paystack] Failed to disable ${sub.subscription_code}:`, err.response?.data || err.message);
    }
  }

  return {
    subscriptionCode: keeper.subscription_code,
    customerCode: keeper.customer?.customer_code ?? incoming.customerCode,
    status: keeper.status ?? incoming.status,
  };
}