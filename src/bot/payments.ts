import { InlineKeyboard } from "grammy";
import { type BotContext } from "./types";
import { prisma } from "../lib/prisma";
import { initializeTransaction } from "../services/paystack";
import {
  BANK_NAME,
  BANK_ACCOUNT_NUMBER,
  BANK_ACCOUNT_NAME,
  BANK_TRANSFER_AMOUNT,
  ADMIN_TELEGRAM_ID,
} from "../utils/constants";

// ── "Go Pro 👑" reply keyboard handler ─────────────────────────────────────
export async function handleGoPro(ctx: BotContext) {
  await ctx.reply(
    `*👑 Wisa Pro — Unlimited Potential*\n\n` +
      `Here's what Pro unlocks for you:\n\n` +
      `✨ *Unlimited AI refinements* — polish every log entry\n` +
      `🎙️ *Voice logs* — speak your log, we transcribe it\n` +
      `📊 *Priority support* — we've got your back\n\n` +
      `*Price: ₦5,000 / month*\n\n` +
      `Ready to level up your logbook? 👇`,
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard()
        .text("🏦 Pay via Bank Transfer", "pay_manual")
        .row()
        .text("Maybe later 👋", "nav_menu"),
    }
  );
}

// ── "Pay with Paystack 💳" callback ─────────────────────────────────────────
export async function handlePayPaystack(ctx: BotContext) {
  await ctx.answerCallbackQuery();

  const telegramId = BigInt(ctx.from!.id);

  // Check if user is already Pro
  const user = await prisma.user.findUnique({ where: { telegramId } });
  if (user?.isPro) {
    await ctx.reply("You're already on Pro! 👑 Keep slaying those logs 🔥");
    return;
  }

  await ctx.reply("Generating your payment link, one sec... ⏳");

  try {
    const { authorization_url, reference } = await initializeTransaction(telegramId);

    await ctx.reply(
      `Here's your secure payment link 🔐\n\nReference: \`${reference}\``,
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard()
          .url("Pay ₦5,000 💳", authorization_url)
          .row()
          .text("I've paid ✅", "check_payment")
          .text("Cancel ❌", "nav_menu"),
      }
    );
  } catch (err) {
    console.error("Paystack initializeTransaction failed:", err);
    await ctx.reply(
      "Oops! Couldn't generate a payment link right now. Please try again in a moment 🙏"
    );
  }
}

// ── "I've paid ✅" callback — manual check nudge ─────────────────────────────
export async function handleCheckPayment(ctx: BotContext) {
  await ctx.answerCallbackQuery();
  const telegramId = BigInt(ctx.from!.id);
  const user = await prisma.user.findUnique({ where: { telegramId } });

  if (user?.isPro) {
    await ctx.reply(
      "You're already Pro! 👑 Your logbook is about to be legendary ✨"
    );
  } else {
    await ctx.reply(
      "We haven't received your payment confirmation yet 🔄\n\n" +
        "Paystack will notify us automatically once your payment is confirmed. " +
        "If you completed the payment, it should reflect within a minute. " +
        "If you're stuck, reach out for support 🙏"
    );
  }
}

// ── "Pay via Bank Transfer 🏦" callback ──────────────────────────────────────
export async function handlePayManual(ctx: BotContext) {
  await ctx.answerCallbackQuery();

  const telegramId = BigInt(ctx.from!.id);
  const user = await prisma.user.findUnique({ where: { telegramId } });

  if (user?.isPro) {
    await ctx.reply("You're already on Pro! 👑 Keep slaying those logs 🔥");
    return;
  }

  await ctx.reply(
    `*🏦 Bank Transfer Payment*\n\n` +
      `Please transfer *${BANK_TRANSFER_AMOUNT}* to the account below:\n\n` +
      `🏛 *Bank:* ${BANK_NAME}\n` +
      `💳 *Account Number:* \`${BANK_ACCOUNT_NUMBER}\`\n` +
      `👤 *Account Name:* ${BANK_ACCOUNT_NAME}\n\n` +
      `Once you've sent the money, tap the button below and we'll verify it manually ⬇️`,
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard()
        .text("✅ I've sent it!", "manual_sent")
        .row()
        .text("Cancel ❌", "nav_menu"),
    }
  );
}

// ── "I've sent it!" callback — records pending payment, notifies admin ───────
export async function handleManualSent(ctx: BotContext) {
  await ctx.answerCallbackQuery();

  const telegramId = BigInt(ctx.from!.id);
  const user = await prisma.user.findUnique({ where: { telegramId } });

  if (!user) {
    await ctx.reply("Something went wrong. Please try again 🙏");
    return;
  }

  if (user.isPro) {
    await ctx.reply("You're already on Pro! 👑");
    return;
  }

  // Check if there's already a pending request from this user
  const existing = await prisma.manualPayment.findFirst({
    where: { userId: user.id, status: "pending" },
  });

  if (existing) {
    await ctx.reply(
      "⏳ Your payment is already being reviewed. We'll notify you once it's approved. Hang tight!"
    );
    return;
  }

  // Create pending record
  const payment = await prisma.manualPayment.create({
    data: { userId: user.id, status: "pending" },
  });

  // Confirm to user
  await ctx.reply(
    `✅ *Got it!* Your payment has been submitted for review.\n\n` +
      `We'll verify it and activate your Pro account shortly. ` +
      `You'll get a message here as soon as it's approved 🙏`,
    { parse_mode: "Markdown" }
  );

  // Notify admin
  if (ADMIN_TELEGRAM_ID === 0n) {
    console.warn("[payments] ADMIN_TELEGRAM_ID is not set – skipping admin notification");
    return;
  }

  const userName = user.username ? `@${user.username}` : user.firstName;
  await ctx.api.sendMessage(
    Number(ADMIN_TELEGRAM_ID),
    `💰 *New Manual Payment Request*\n\n` +
      `👤 *User:* ${userName} (ID: \`${user.telegramId}\`)\n` +
      `💳 *Amount:* ${BANK_TRANSFER_AMOUNT}\n` +
      `🆔 *Payment ID:* \`${payment.id}\`\n\n` +
      `Did you receive the transfer?`,
    {
      parse_mode: "Markdown",
      reply_markup: {
        inline_keyboard: [
          [
            { text: "✅ Approve", callback_data: `mpay_approve_${payment.id}` },
            { text: "❌ Reject", callback_data: `mpay_reject_${payment.id}` },
          ],
        ],
      },
    }
  );
}

// ── Admin: Approve manual payment ────────────────────────────────────────────
export async function handleAdminApprove(ctx: BotContext) {
  await ctx.answerCallbackQuery();

  const data = ctx.callbackQuery?.data ?? "";
  const paymentId = parseInt(data.replace("mpay_approve_", ""), 10);

  const payment = await prisma.manualPayment.findUnique({
    where: { id: paymentId },
    include: { user: true },
  });

  if (!payment) {
    await ctx.reply("Payment record not found.");
    return;
  }

  if (payment.status !== "pending") {
    await ctx.reply(`This payment has already been ${payment.status}.`);
    return;
  }

  // Activate Pro
  await prisma.$transaction([
    prisma.manualPayment.update({ where: { id: paymentId }, data: { status: "approved" } }),
    prisma.user.update({ where: { id: payment.userId }, data: { isPro: true } }),
  ]);

  // Notify user
  await ctx.api.sendMessage(
    Number(payment.user.telegramId),
    `🎉 *You're now on Wisa Pro!*\n\n` +
      `Your bank transfer has been confirmed. Welcome to the Pro club 👑\n\n` +
      `Enjoy unlimited AI refinements, voice logs, and more!`,
    { parse_mode: "Markdown" }
  );

  // Update admin message
  await ctx.editMessageText(
    `✅ Approved — ${payment.user.username ? `@${payment.user.username}` : payment.user.firstName} is now Pro.`
  );
}

// ── Admin: Reject manual payment ─────────────────────────────────────────────
export async function handleAdminReject(ctx: BotContext) {
  await ctx.answerCallbackQuery();

  const data = ctx.callbackQuery?.data ?? "";
  const paymentId = parseInt(data.replace("mpay_reject_", ""), 10);

  const payment = await prisma.manualPayment.findUnique({
    where: { id: paymentId },
    include: { user: true },
  });

  if (!payment) {
    await ctx.reply("Payment record not found.");
    return;
  }

  if (payment.status !== "pending") {
    await ctx.reply(`This payment has already been ${payment.status}.`);
    return;
  }

  await prisma.manualPayment.update({ where: { id: paymentId }, data: { status: "rejected" } });

  // Notify user
  await ctx.api.sendMessage(
    Number(payment.user.telegramId),
    `❌ *Payment Not Confirmed*\n\n` +
      `We couldn't verify your transfer of ${BANK_TRANSFER_AMOUNT}.\n\n` +
      `Please double-check the account details and try again, or reach out if you think this is a mistake 🙏`,
    { parse_mode: "Markdown" }
  );

  // Update admin message
  await ctx.editMessageText(
    `❌ Rejected — ${payment.user.username ? `@${payment.user.username}` : payment.user.firstName}'s payment was declined.`
  );
}
