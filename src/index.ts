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

      // ✅ FIX #3: NEW — Recover held logs from catch-up session
      try {
        const sessionKey = telegramId.toString();
        const sessionRow = await prisma.session.findUnique({
          where: { key: sessionKey },
          select: { key: true, value: true },
        });

        if (sessionRow?.value) {
          let sessionData: any = null;
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

      // ✅ Send personalized notification based on whether heldLogs were recovered
      const hasHeldLogs = sessionData?.catchup?.heldLogs && Array.isArray(sessionData.catchup.heldLogs) && sessionData.catchup.heldLogs.length > 0;
      
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