import "dotenv/config";
import crypto from "crypto";
import { bot } from "./bot/index";
import { startScheduler } from "./services/scheduler";
import { startUserActivity } from "./services/userActivity";
import express from "express";
import { prisma } from "./lib/prisma";
import { adminRouter } from "./admin/router";

const app = express();
app.use(express.json());

// Admin dashboard (HTTP Basic auth — set ADMIN_USER + ADMIN_PASSWORD env vars)
app.use("/admin", adminRouter);

// Paystack webhook endpoint
app.post("/webhook/paystack", async (req, res) => {
  const rawBody = JSON.stringify(req.body);
  const signature = req.headers["x-paystack-signature"] as string | undefined;

  console.log(`[webhook] Paystack event received: ${req.body?.event ?? "unknown"} | sig present: ${!!signature}`);

  // Paystack signs with your Secret Key — PAYSTACK_WEBHOOK_SECRET must equal PAYSTACK_SECRET_KEY
  const hash = crypto
    .createHmac("sha512", process.env.PAYSTACK_WEBHOOK_SECRET!)
    .update(rawBody)
    .digest("hex");

  if (hash !== signature) {
    console.warn(`[webhook] Signature mismatch. Expected ${hash.slice(0, 16)}…, got ${String(signature).slice(0, 16)}…`);
    return res.sendStatus(401);
  }

  if (req.body.event === "charge.success") {
    const telegramId = BigInt(req.body.data.metadata?.telegramId ?? "0");
    const ref: string = req.body.data.reference;
    const email: string = req.body.data.customer?.email ?? "";

    console.log(`[webhook] charge.success — telegramId=${telegramId} ref=${ref} email=${email}`);

    try {
      await prisma.user.update({ where: { telegramId }, data: { isPro: true } });

      const user = await prisma.user.findUnique({ where: { telegramId } });
      if (user) {
        await prisma.subscription.upsert({
          where: { paystackRef: ref },
          update: { status: "active", endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000) },
          create: {
            userId: user.id,
            paystackRef: ref,
            status: "active",
            startDate: new Date(),
            endDate: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000),
          },
        });
        console.log(`[webhook] User ${user.id} marked as Pro. Sub upserted.`);
      } else {
        console.warn(`[webhook] No user found for telegramId=${telegramId}`);
      }

      await bot.api.sendMessage(
        Number(telegramId),
        `👑 *You're in!* Welcome to the Pro squad!\n\n` +
          `Unlimited AI refinements ✨ and unlimited voice logs 🎤 are now yours. ` +
          `Your logbook just levelled up — let's go! 🚀`,
        { parse_mode: "Markdown" },
      );
    } catch (err) {
      console.error("[webhook] Error processing charge.success:", err);
      // Still return 200 so Paystack doesn’t retry indefinitely
    }
  }

  return res.sendStatus(200);
});

async function main() {
  await prisma.$connect();
  startScheduler(bot);
  startUserActivity(bot);
  bot.start();
  app.listen(process.env.PORT || 3000, () =>
    console.log(`Server running on port ${process.env.PORT || 3000}`)
  );
}

main();