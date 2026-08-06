import "dotenv/config";
import { bot } from "./bot/index";
import { getMainMenuKeyboard } from "./bot/onboarding";
import { startScheduler } from "./services/scheduler";
import { startUserActivity } from "./services/userActivity";
import express from "express";
import { prisma } from "./lib/prisma";
import { adminRouter } from "./admin/router";
import { dashboardRouter } from "./dashboard/routes";
import { flushReplayBuffer, captureReplayError } from "./services/replayCapture";
import { activateStorageForUser } from "./bot/payments";
import { resolveUser } from "./services/resolveUser";
import {
  collapseToOneSubscription,
  hasValidPaystackSignature,
  isRescuePassPayment,
  readPaystackCustomField,
} from "./services/paystack";
import { markRescuePassPaid, resumeCatchupGeneration, sweepAbandonedCatchupBlocks } from "./bot/catchupFlow";
import { InlineKeyboard } from "grammy";

// Fail fast rather than discovering a bad config one silently-rejected payment at
// a time: an empty secret hashes fine and 401s every delivery, and a missing one
// throws inside the handler. Both look like "payments stopped working".
const REQUIRED_ENV = ["PAYSTACK_WEBHOOK_SECRET", "PAYSTACK_SECRET_KEY", "TELEGRAM_BOT_TOKEN"] as const;
for (const key of REQUIRED_ENV) {
  if (!process.env[key]?.trim()) {
    console.error(`[boot] Missing or empty required env var ${key} — refusing to start.`);
    process.exit(1);
  }
}

const app = express();

const RENEWAL_FAILED_MESSAGE =
  `⚠️ *Your Wisa Pro renewal didn't go through.*\n\n` +
  `No stress — your logs are safe. Paystack will retry automatically over the next few days, but if you want to keep Pro active without interruption, you can renew now 👇`;

function extractSubscriptionCode(payload: any): string | undefined {
  return payload?.data?.subscription_code ?? payload?.data?.subscription?.subscription_code;
}

// Paystack webhook endpoint
app.post("/webhook/paystack", express.raw({ type: "application/json" }), async (req, res) => {
  const rawBody = Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "";

  // Authenticate BEFORE parsing — nothing unverified reaches the parser or the DB.
  // Paystack signs with your Secret Key: PAYSTACK_WEBHOOK_SECRET must equal PAYSTACK_SECRET_KEY.
  if (!hasValidPaystackSignature(rawBody, req.headers["x-paystack-signature"])) {
    console.warn("[webhook] Rejected Paystack delivery — signature missing or invalid.");
    return res.sendStatus(401);
  }

  let payload: any;
  try {
    payload = JSON.parse(rawBody);
  } catch {
    console.warn("[webhook] Invalid JSON payload");
    return res.sendStatus(400);
  }

  console.log(`[webhook] Paystack event received: ${payload?.event ?? "unknown"}`);

  if (payload.event === "charge.success") {
    // ── SIWES Rescue Pass ────────────────────────────────────────────────────
    // One-off catch-up purchase — must be handled BEFORE activateStorageForUser
    // so it never grants a 30-day Pro subscription.
    if (isRescuePassPayment(payload.data?.metadata)) {
      const catchupSessionId = readPaystackCustomField(payload.data?.metadata, "catchup_session_id");
      const rescueRef: string = payload.data?.reference;

      if (!catchupSessionId) {
        console.warn(`[webhook] rescue_pass charge.success without catchup_session_id (ref=${rescueRef})`);
        return res.sendStatus(200);
      }

      try {
        const paidAt = payload.data?.paid_at ? new Date(payload.data.paid_at) : new Date();
        const catchupSession = await markRescuePassPaid({
          catchupSessionId,
          reference: rescueRef,
          amount: Number(payload.data?.amount ?? 0),
          currency: String(payload.data?.currency ?? "NGN"),
          paidAt,
          providerMetadata: payload.data?.metadata ?? null,
        });

        if (!catchupSession) return res.sendStatus(200);

        console.log(`[webhook] rescue_pass paid — session=${catchupSessionId} ref=${rescueRef}`);

        // Generation calls OpenAI and can outlive Paystack's webhook timeout —
        // acknowledge first, then fulfil in the background. resumeCatchupGeneration
        // is idempotent (in-flight guard + fulfilledBlocks ledger).
        res.sendStatus(200);
        void resumeCatchupGeneration(catchupSessionId).catch((err) => {
          console.error("[webhook] rescue_pass fulfilment failed:", err);
        });
        return;
      } catch (err) {
        console.error("[webhook] Error processing rescue_pass charge.success:", err);
        return res.sendStatus(500);
      }
    }

    const resolvedUser = await resolveUser(payload);
    if (!resolvedUser) {
      console.warn(
        `[webhook] charge.success — could not resolve user (ref=${payload.data?.reference}, email=${payload.data?.customer?.email ?? "n/a"})`,
      );
      return res.sendStatus(200);
    }

    const telegramId = resolvedUser.telegramId;
    const ref: string = payload.data.reference;
    const email: string = payload.data.customer?.email ?? "";

    console.log(`[webhook] charge.success — telegramId=${telegramId} ref=${ref} email=${email}`);

    try {
      const paidAt = payload.data?.paid_at ? new Date(payload.data.paid_at) : new Date();
      const { alreadyProcessed, newRenewalDate } = await activateStorageForUser({
        userId: resolvedUser.id,
        currentRenewalDate: resolvedUser.nextRenewalDate,
        reference: ref,
        amount: Number(payload.data?.amount ?? 0),
        currency: String(payload.data?.currency ?? "NGN"),
        provider: "paystack",
        metadata: payload.data?.metadata ?? undefined,
        paidAt,
      });

      if (email && email !== resolvedUser.paymentEmail) {
        await prisma.user.update({ where: { id: resolvedUser.id }, data: { paymentEmail: email } });
      }

      if (alreadyProcessed) {
        console.log(`[webhook] Duplicate charge.success ignored (ref=${ref})`);
        return res.sendStatus(200);
      }

      console.log(`[webhook] User ${resolvedUser.id} storage unlocked. Renewal set to ${newRenewalDate.toISOString()}`);

      try {
        await bot.api.sendMessage(
          Number(telegramId),
          `🎉 *Storage unlocked!*\n\n` +
            `You're all set for the next 30 days 🔓\n\n` +
            `You now have unlimited log storage, unlimited voice logs, and unlimited AI refinements.`,
          { parse_mode: "Markdown" },
        );
      } catch (notifyErr) {
        console.error("[webhook] Failed to send unlock notification:", notifyErr);
      }

      // Post-payment UX: if they were blocked mid-log, prompt them to resume.
      try {
        const sessionKey = telegramId.toString();
        const sessionRow = await prisma.session.findUnique({
          where: { key: sessionKey },
          select: { key: true, value: true },
        });

        if (sessionRow?.value) {
          const now = Date.now();
          let sessionData: any = null;
          try {
            sessionData = JSON.parse(sessionRow.value);
          } catch {
            sessionData = null;
          }

          const action = sessionData?.postPaymentAction;
          const isFresh =
            action &&
            typeof action.createdAt === "number" &&
            now - action.createdAt < 60 * 60 * 1000; // 1h, aligned with flow expiry

          let shouldPersistSession = false;
          let sendResumePendingLog = false;
          let sendResumeStartLogIsoDate: string | null = null;

          if (action && isFresh) {
            // If there's a draft in progress, keep them in that flow.
            let hasDraft =
              sessionData?.awaitingLog === true &&
              Array.isArray(sessionData?.pendingLogParts) &&
              sessionData.pendingLogParts.length > 0;

            // If we paused the draft during payment email capture, restore it now.
            if (!hasDraft && action.type === "resume_pending_log") {
              const paused = sessionData?.pausedLogDraft;
              if (
                paused &&
                Array.isArray(paused.pendingLogParts) &&
                paused.pendingLogParts.length > 0
              ) {
                sessionData.awaitingLog = true;
                sessionData.pendingLogParts = paused.pendingLogParts;
                sessionData.pendingLogDate = paused.pendingLogDate;
                sessionData.lastLogMessageAt = paused.lastLogMessageAt;
                sessionData.autoSavePromptSent = paused.autoSavePromptSent;
                sessionData.flowStartedAt = now;
                delete sessionData.pausedLogDraft;
                hasDraft = true;
                shouldPersistSession = true;
              }
            }

            if (action.type === "resume_pending_log" && hasDraft) {
              sessionData.flowStartedAt = now;
              shouldPersistSession = true;
              sendResumePendingLog = true;
            } else if (action.type === "start_log" && typeof action.isoDate === "string") {
              sendResumeStartLogIsoDate = action.isoDate;
            }
          }

          // Clear even if stale, to avoid surprise resumes later.
          if (sessionData?.postPaymentAction) {
            delete sessionData.postPaymentAction;
            shouldPersistSession = true;
          }

          if (shouldPersistSession) {
            await prisma.session.update({
              where: { key: sessionKey },
              data: { value: JSON.stringify(sessionData) },
            });
          }

          if (sendResumePendingLog) {
            await bot.api.sendMessage(
              Number(telegramId),
              `✅ *Payment confirmed — you're unblocked.*\n\n` +
                `Keep writing your log and I'll refine it automatically as soon as you send it.`,
              {
                parse_mode: "Markdown",
              },
            );
          } else if (sendResumeStartLogIsoDate) {
            await bot.api.sendMessage(
              Number(telegramId),
              `✅ *Payment confirmed!*\n\nYou can now continue writing your log. Tap below to jump right back in 👇`,
              {
                parse_mode: "Markdown",
                reply_markup: new InlineKeyboard().text(
                  "✍️ Continue writing your log",
                  `resume_write_log_${sendResumeStartLogIsoDate}`,
                ),
              },
            );
          }
        }
      } catch (err) {
        console.error("[webhook] post-payment resume check failed:", err);
      }

      try {
        await bot.api.sendMessage(Number(telegramId), "Main menu updated 👇", {
          reply_markup: getMainMenuKeyboard(true),
        });
      } catch (menuErr) {
        console.error("[webhook] Failed to send menu update:", menuErr);
      }
    } catch (err) {
      console.error("[webhook] Error processing charge.success:", err);
      captureReplayError(telegramId, err, "webhook:charge.success");
      return res.sendStatus(500);
    }
  }

  if (payload.event === "subscription.create") {
    const resolvedUser = await resolveUser(payload);
    if (!resolvedUser) {
      console.warn(
        `[webhook] subscription.create — could not resolve user (code=${payload.data?.subscription_code ?? "n/a"}, email=${payload.data?.customer?.email ?? "n/a"})`,
      );
      return res.sendStatus(200);
    }

    const subscriptionCode: string | undefined = payload.data?.subscription_code;
    if (!subscriptionCode) {
      console.warn(`[webhook] subscription.create — missing subscription_code for user ${resolvedUser.id}`);
      return res.sendStatus(200);
    }

    const incoming = {
      subscriptionCode,
      customerCode: payload.data?.customer?.customer_code as string | undefined,
      status: (payload.data?.status ?? "active") as string,
    };

    let survivor = incoming;
    const subEmail: string | undefined = payload.data?.customer?.email ?? resolvedUser.paymentEmail ?? undefined;
    if (subEmail) {
      try {
        survivor = await collapseToOneSubscription(subEmail, incoming);
      } catch (err) {
        console.error("[webhook] subscription.create — duplicate collapse failed, storing incoming code:", err);
      }
    }

    try {
      await prisma.subscription.upsert({
        where: { userId: resolvedUser.id },
        update: {
          subscriptionCode: survivor.subscriptionCode,
          customerCode: survivor.customerCode,
          status: survivor.status,
        },
        create: {
          userId: resolvedUser.id,
          paystackRef: survivor.subscriptionCode,
          subscriptionCode: survivor.subscriptionCode,
          customerCode: survivor.customerCode,
          status: survivor.status,
          startDate: new Date(),
          endDate: resolvedUser.nextRenewalDate ?? new Date(),
        },
      });
      console.log(`[webhook] subscription.create — linked ${survivor.subscriptionCode} to user ${resolvedUser.id}`);
    } catch (err) {
      console.error("[webhook] Error processing subscription.create:", err);
      captureReplayError(resolvedUser.telegramId, err, "webhook:subscription.create");
      return res.sendStatus(500);
    }

    return res.sendStatus(200);
  }

  if (payload.event === "subscription.not_renew") {
    const subscriptionCode = extractSubscriptionCode(payload);
    if (!subscriptionCode) {
      console.warn("[webhook] subscription.not_renew — no subscription_code:", JSON.stringify(payload?.data ?? {}));
      return res.sendStatus(200);
    }
    try {
      await prisma.subscription.updateMany({ where: { subscriptionCode, status: { not: "cancelled" } }, data: { status: "non-renewing" } });
      console.log(`[webhook] subscription.not_renew — marked ${subscriptionCode} non-renewing`);
    } catch (err) {
      console.error("[webhook] Error processing subscription.not_renew:", err);
      return res.sendStatus(500);
    }
    return res.sendStatus(200);
  }

  if (payload.event === "subscription.disable") {
    const subscriptionCode = extractSubscriptionCode(payload);
    if (!subscriptionCode) {
      console.warn("[webhook] subscription.disable — no subscription_code:", JSON.stringify(payload?.data ?? {}));
      return res.sendStatus(200);
    }
    try {
      await prisma.subscription.updateMany({ where: { subscriptionCode }, data: { status: "cancelled" } });
      console.log(`[webhook] subscription.disable — marked ${subscriptionCode} cancelled`);
    } catch (err) {
      console.error("[webhook] Error processing subscription.disable:", err);
      return res.sendStatus(500);
    }
    return res.sendStatus(200);
  }

  if (payload.event === "invoice.payment_failed") {
    const resolvedUser = await resolveUser(payload);
    if (!resolvedUser) {
      console.warn(
        `[webhook] invoice.payment_failed — could not resolve user (code=${extractSubscriptionCode(payload) ?? "n/a"}, email=${payload.data?.customer?.email ?? "n/a"})`,
      );
      return res.sendStatus(200);
    }
    if (resolvedUser.nextRenewalDate && resolvedUser.nextRenewalDate > new Date()) {
      console.log(`[webhook] invoice.payment_failed — user ${resolvedUser.id} still in window, skipping dunning`);
      return res.sendStatus(200);
    }
    try {
      await bot.api.sendMessage(Number(resolvedUser.telegramId), RENEWAL_FAILED_MESSAGE, {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard().text("🔓 Renew now", "go_pro"),
      });
    } catch (err) {
      console.error("[webhook] invoice.payment_failed — failed to send dunning message:", err);
    }
    return res.sendStatus(200);
  }

  return res.sendStatus(200);
});

app.use(express.json());

// Admin dashboard (HTTP Basic auth — set ADMIN_USER + ADMIN_PASSWORD env vars)
app.use("/admin", adminRouter);

// Dashboard API (JWT Bearer auth)
app.use("/api/dashboard", dashboardRouter);

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

  // Recover any block whose worker was killed mid-generation on the last run.
  // Fire-and-forget: a paid session must not block the bot from coming up.
  void sweepAbandonedCatchupBlocks();

  startScheduler(bot);
  startUserActivity(bot);
  bot.start();
  app.listen(process.env.PORT || 3000, () =>
    console.log(`Server running on port ${process.env.PORT || 3000}`)
  );
}

main();