import "dotenv/config";
import crypto from "crypto";
import { bot } from "./bot/index";
import { getMainMenuKeyboard } from "./bot/onboarding";
import { startScheduler } from "./services/scheduler";
import { startUserActivity } from "./services/userActivity";
import express from "express";
import { prisma } from "./lib/prisma";
import { adminRouter } from "./admin/router";
import { flushReplayBuffer, captureReplayError } from "./services/replayCapture";

const app = express();

// Paystack webhook endpoint
app.post("/webhook/paystack", express.raw({ type: "application/json" }), async (req, res) => {
  const rawBody = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";
  let payload: any;

  try {
    payload = JSON.parse(rawBody);
  } catch {
    console.warn("[webhook] Invalid JSON payload");
    return res.sendStatus(400);
  }

  const signature = req.headers["x-paystack-signature"] as string | undefined;

  console.log(`[webhook] Paystack event received: ${payload?.event ?? "unknown"} | sig present: ${!!signature}`);

  // Paystack signs with your Secret Key — PAYSTACK_WEBHOOK_SECRET must equal PAYSTACK_SECRET_KEY
  const hash = crypto
    .createHmac("sha512", process.env.PAYSTACK_WEBHOOK_SECRET!)
    .update(rawBody)
    .digest("hex");

  if (hash !== signature) {
    console.warn(`[webhook] Signature mismatch. Expected ${hash.slice(0, 16)}…, got ${String(signature).slice(0, 16)}…`);
    return res.sendStatus(401);
  }

  if (payload.event === "charge.success") {
    const telegramId = BigInt(payload.data.metadata?.telegramId ?? "0");
    const ref: string = payload.data.reference;
    const email: string = payload.data.customer?.email ?? "";

    console.log(`[webhook] charge.success — telegramId=${telegramId} ref=${ref} email=${email}`);

    try {
      const renewalDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);

      await prisma.user.update({
        where: { telegramId },
        data: {
          isPro: true,
          storageUnlocked: true,
          nextRenewalDate: renewalDate,
          ...(email ? { paymentEmail: email } : {}),
        },
      });

      const user = await prisma.user.findUnique({ where: { telegramId } });
      if (user) {
        await prisma.subscription.upsert({
          where: { userId: user.id },
          update: { paystackRef: ref, status: "active", endDate: renewalDate },
          create: {
            userId: user.id,
            paystackRef: ref,
            status: "active",
            startDate: new Date(),
            endDate: renewalDate,
          },
        });
        console.log(`[webhook] User ${user.id} storage unlocked. Renewal set to ${renewalDate.toISOString()}`);
      } else {
        console.warn(`[webhook] No user found for telegramId=${telegramId}`);
      }

      await bot.api.sendMessage(
        Number(telegramId),
        `🎉 *Storage unlocked!*\n\n` +
          `You're all set for the next 30 days 🔓\n\n` +
          `You now have unlimited log storage, unlimited voice logs, and unlimited AI refinements.`,
        { parse_mode: "Markdown" },
      );

      await bot.api.sendMessage(Number(telegramId), "Main menu updated 👇", {
        reply_markup: getMainMenuKeyboard(true),
      });
    } catch (err) {
      console.error("[webhook] Error processing charge.success:", err);      captureReplayError(telegramId, err, "webhook:charge.success");      // Still return 200 so Paystack doesn’t retry indefinitely
    }
  }

  return res.sendStatus(200);
});

app.use(express.json());

// Admin dashboard (HTTP Basic auth — set ADMIN_USER + ADMIN_PASSWORD env vars)
app.use("/admin", adminRouter);

process.on("SIGTERM", async () => {
  console.log("[shutdown] Flushing replay buffer...");
  await flushReplayBuffer();
  process.exit(0);
});

process.on("SIGINT", async () => {
  console.log("[shutdown] Flushing replay buffer...");
  await flushReplayBuffer();
  process.exit(0);
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