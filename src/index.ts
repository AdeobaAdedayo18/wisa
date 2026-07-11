import "dotenv/config";
import crypto from "crypto";
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
import { collapseToOneSubscription } from "./services/paystack";
import { InlineKeyboard } from "grammy";

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

      // ✅ FIX #3: NEW — Recover held logs from catch-up session
      let sessionData: any = null; // 🚀 FIXED: Moved outside the try block so the build passes!
      try {
        const sessionKey = telegramId.toString();
        const sessionRow = await prisma.session.findUnique({
          where: { key: sessionKey },
          select: { key: true, value: true },
        });

        if (sessionRow?.value) {
          try {
            sessionData = JSON.parse(sessionRow.value);
          } catch {
            sessionData = null;
          }

          // ✅ If there are heldLogs, save them now!
          if (sessionData?.catchup?.heldLogs && Array.isArray(sessionData.catchup.heldLogs)) {
            const heldLogs = sessionData.catchup.heldLogs;
            const dbUser = await prisma.user.findUnique({
              where: { telegramId },
              select: { id: true }
            });

            if (dbUser && heldLogs.length > 0) {
              const insertData = heldLogs.map((log: any) => ({
                userId: dbUser.id,
                content: log.content,
                isAiRefined: true,
                isVoice: false,
                logDate: log.logDate ? new Date(log.logDate) : new Date(),
              }));

              await prisma.$transaction([
                prisma.log.createMany({ data: insertData }),
                prisma.user.update({
                  where: { id: dbUser.id },
                  data: { logCount: { increment: heldLogs.length } }
                })
              ]);

              // ✅ Clear the held logs from session
              delete sessionData.catchup.heldLogs;
              delete sessionData.catchup.savedLogsCount;
              await prisma.session.update({
                where: { key: sessionKey },
                data: { value: JSON.stringify(sessionData) },
              });

              console.log(`[webhook] Recovered ${heldLogs.length} held logs for user ${dbUser.id}`);
            }
          }
        }
      } catch (heldErr) {
        console.error("[webhook] Failed to recover held logs:", heldErr);
        // Don't fail the payment flow for this
      }

      const hasHeldLogs = sessionData?.catchup?.heldLogs && Array.isArray(sessionData.catchup.heldLogs) && sessionData.catchup.heldLogs.length > 0;

      try {
        if (hasHeldLogs) {
          await bot.api.sendMessage(
            Number(telegramId),
            `🎉 *Payment successful!* All your pending logs have been unlocked and instantly added to your logbook!`,
            { parse_mode: "Markdown" },
          );
        } else {
          await bot.api.sendMessage(
            Number(telegramId),
            `🎉 *Storage unlocked!*\n\n` +
              `You're all set for the next 30 days 🔓\n\n` +
              `You now have unlimited log storage, unlimited voice logs, and unlimited AI refinements.`,
            { parse_mode: "Markdown" },
          );
        }
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
  startScheduler(bot);
  startUserActivity(bot);
  bot.start();
  app.listen(process.env.PORT || 3000, () =>
    console.log(`Server running on port ${process.env.PORT || 3000}`)
  );
}

main();