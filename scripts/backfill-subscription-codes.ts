import "dotenv/config";
import axios from "axios";
import { prisma } from "../src/lib/prisma";

const PAYSTACK_BASE = "https://api.paystack.co";
const headers = { Authorization: `Bearer ${process.env.PAYSTACK_SECRET_KEY}` };
const APPLY = process.argv.includes("--apply");

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function fetchActiveSubscriptions(email: string): Promise<Array<any>> {
  const res = await axios.get(
    `${PAYSTACK_BASE}/subscription?email=${encodeURIComponent(email)}`,
    { headers },
  );
  const subs = (res.data?.data ?? []) as Array<any>;
  return subs.filter((s) => s.status === "active");
}

async function main(): Promise<void> {
  const rows = await prisma.subscription.findMany({
    where: { subscriptionCode: null },
    include: { user: { select: { id: true, paymentEmail: true } } },
  });

  console.log(`[backfill] ${rows.length} rows missing subscriptionCode. Mode: ${APPLY ? "APPLY" : "DRY RUN"}`);

  let linked = 0, legacy = 0, ambiguous = 0, noEmail = 0;

  for (const row of rows) {
    const email = row.user.paymentEmail;
    if (!email) {
      noEmail++;
      console.log(`[backfill] user ${row.user.id} — no paymentEmail, skipping`);
      continue;
    }

    let active: Array<any>;
    try {
      active = await fetchActiveSubscriptions(email);
    } catch (err: any) {
      console.error(`[backfill] user ${row.user.id} — Paystack lookup failed:`, err.response?.data || err.message);
      continue;
    }

    if (active.length === 0) {
      legacy++;
      console.log(`[backfill] user ${row.user.id} (${email}) — no active Paystack subscription (legacy/one-time payer), leaving NULL`);
      await delay(250);
      continue;
    }

    if (active.length > 1) {
      ambiguous++;
      console.warn(
        `[backfill] user ${row.user.id} (${email}) — ${active.length} active subscriptions (possible double-billing): ${active.map((s) => s.subscription_code).join(", ")} — manual review, not writing`,
      );
      await delay(250);
      continue;
    }

    const sub = active[0];
    console.log(`[backfill] user ${row.user.id} (${email}) — ${APPLY ? "linking" : "would link"} ${sub.subscription_code}`);
    if (APPLY) {
      await prisma.subscription.update({
        where: { id: row.id },
        data: {
          subscriptionCode: sub.subscription_code,
          customerCode: sub.customer?.customer_code ?? null,
          status: sub.status,
        },
      });
    }
    linked++;
    await delay(250);
  }

  console.log(
    `[backfill] Done. linked=${linked} legacy=${legacy} ambiguous=${ambiguous} noEmail=${noEmail}` +
      (APPLY ? "" : " (dry run — re-run with --apply to write)"),
  );

  await prisma.$disconnect();
}

main().catch(async (err) => {
  console.error("[backfill] Fatal:", err);
  await prisma.$disconnect();
  process.exit(1);
});
