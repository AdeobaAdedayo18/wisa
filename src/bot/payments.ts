import { InlineKeyboard } from "grammy";
import { type BotContext, clearActiveFlow, startFlow, isFlowExpired } from "./types";
import { prisma } from "../lib/prisma";
import { captureReplayError } from "../services/replayCapture";
import { initializeTransaction, verifyTransaction } from "../services/paystack";
import { getMainMenuKeyboard } from "./onboarding";
import { getMonetizationUserByTelegramId, hasActiveStorage, STORAGE_PRICE_LABEL } from "./monetization";

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

export async function activateStorageForUser(userId: number, renewalDate = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000)): Promise<void> {
  await prisma.user.update({
    where: { id: userId },
    data: {
      isPro: true,
      storageUnlocked: true,
      nextRenewalDate: renewalDate,
    },
  });
}

function unlockKeyboard(url?: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (url) kb.url("💳 Pay with Paystack", url).row();
  return kb.text("I've paid ✅", "check_payment").row().text("Maybe later", "nav_menu");
}

export async function handleGoPro(ctx: BotContext): Promise<void> {
  const telegramId = BigInt(ctx.from!.id);
  const user = await getMonetizationUserByTelegramId(telegramId);
  if (!user) return;

  if (hasActiveStorage(user)) {
    await ctx.reply("🔓 Your storage is already unlocked. You're all set!", {
      reply_markup: getMainMenuKeyboard(true),
    });
    return;
  }

  if (!(await prisma.user.findUnique({ where: { id: user.id }, select: { paymentEmail: true } }))?.paymentEmail) {
    clearActiveFlow(ctx.session);
    ctx.session.awaitingPaymentEmail = true;
    startFlow(ctx.session);

    await ctx.reply(
      `🔓 *Unlock Wisa Storage*\n\n` +
      `Here's what you get:\n\n` +
      `📊 *Unlimited log storage* — we've got your back\n\n` +
      `✨ *Unlimited AI refinements* — polish every log entry\n` +
      `🎙️ *Voice logs* — speak your log, we transcribe it\n` +
      `${STORAGE_PRICE_LABEL}\n` +
        `Before payment, we need your email to send your receipt`,
      { parse_mode: "Markdown" },
    );
    return;
  }

  await ctx.reply(
    `*👑 Wisa Pro — Unlimited Storage*\n\n` +
      `Here's what Pro unlocks for you:\n\n` +
      `📊 *Unlimited log storage* — we've got your back\n\n` +
      `✨ *Unlimited AI refinements* — polish every log entry\n` +
      `🎙️ *Voice logs* — speak your log, we transcribe it\n` +
      `${STORAGE_PRICE_LABEL}\n` +
      `Ready to level up your logbook? 👇`,
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard().text("✨ Let's Gooo", "pay_paystack"),
    },
  );
}

export async function handlePayPaystack(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();

  const telegramId = BigInt(ctx.from!.id);
  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { id: true, storageUnlocked: true, nextRenewalDate: true, paymentEmail: true },
  });

  if (!user) return;

  if (user.storageUnlocked && (!user.nextRenewalDate || user.nextRenewalDate >= new Date())) {
    await ctx.reply("🔓 Your storage is already unlocked.");
    return;
  }

  if (!user.paymentEmail) {
    clearActiveFlow(ctx.session);
    ctx.session.awaitingPaymentEmail = true;
    startFlow(ctx.session);
    await ctx.reply("Before payment, we need your email to send your receipt.");
    return;
  }

  await ctx.reply("Generating your secure payment link, one sec...⏳");

  try {
    const { authorization_url, reference } = await initializeTransaction(telegramId, user.paymentEmail);
    ctx.session.pendingPaystackRef = reference;

    await ctx.reply(
      `Paystack link ready ✅\n\nReference: \`${reference}\``,
      {
        parse_mode: "Markdown",
        reply_markup: unlockKeyboard(authorization_url),
      },
    );
  } catch (err) {
    console.error("[payments] initializeTransaction failed:", err);
    captureReplayError(telegramId, err, "handlePayPaystack", ctx.chat?.id);
    await ctx.reply("I couldn't generate a payment link right now. Please try again in a moment.");
  }
}

export async function handleCheckPayment(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();

  const telegramId = BigInt(ctx.from!.id);
  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: { id: true, firstName: true, storageUnlocked: true, nextRenewalDate: true },
  });

  if (!user) return;

  if (user.storageUnlocked && (!user.nextRenewalDate || user.nextRenewalDate >= new Date())) {
    await ctx.reply("🎉 Payment confirmed. Your storage is already unlocked.");
    return;
  }

  const reference = ctx.session.pendingPaystackRef;
  if (!reference) {
    await ctx.reply(
      "I couldn't find a pending payment reference in this chat. Tap Unlock again and complete payment from the new link.",
    );
    return;
  }

  try {
    const result = await verifyTransaction(reference);
    if (result.status !== "success") {
      await ctx.reply(
        "Payment is not confirmed yet. If you just paid, wait a minute and tap `I've paid` again.",
      );
      return;
    }

    await activateStorageForUser(user.id);

    await ctx.reply(
      `🎉 *Storage unlocked, ${user.firstName}!*\n\n` +
        `You're all set for the next 30 days 🔓\n\n` +
        `Your logs are flowing again - plus you've got unlimited voice logs and AI refinements now. Go make today's log count 💪`,
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard().text("✍️ Write today's log", "nav_write"),
      },
    );

    await ctx.reply("Main menu updated 👇", {
      reply_markup: getMainMenuKeyboard(true),
    });
  } catch (err) {
    console.error("[payments] verifyTransaction failed:", err);
    captureReplayError(telegramId, err, "handleCheckPayment", ctx.chat?.id);
    await ctx.reply(
      "I couldn't verify that payment right now. If you paid successfully, Paystack webhook will unlock you automatically shortly.",
    );
  }
}

export async function handlePayManual(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  await ctx.reply(
    "🏦 Bank transfer has been retired. Please use Paystack to unlock storage instantly.",
    {
      reply_markup: new InlineKeyboard().text("💳 Pay with Paystack", "pay_paystack"),
    },
  );
}

export async function handleManualSent(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  await ctx.reply(
    "Manual confirmation is no longer supported. Tap below to pay via Paystack.",
    {
      reply_markup: new InlineKeyboard().text("💳 Pay with Paystack", "pay_paystack"),
    },
  );
}

export async function handleAdminApprove(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery("Manual payments are disabled.");
}

export async function handleAdminReject(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery("Manual payments are disabled.");
}

export async function handlePaymentEmailText(ctx: BotContext): Promise<boolean> {
  if (!ctx.session.awaitingPaymentEmail) return false;
  if (isFlowExpired(ctx.session)) return false;

  const email = (ctx.message?.text ?? "").trim().toLowerCase();
  if (!isValidEmail(email)) {
    await ctx.reply("That email looks invalid. Please send a valid email address.");
    return true;
  }

  ctx.session.awaitingPaymentEmail = false;
  ctx.session.pendingPaymentEmail = email;

  const telegramId = BigInt(ctx.from!.id);
  await prisma.user.update({ where: { telegramId }, data: { paymentEmail: email } });

  await ctx.reply(
    `✅ Saved! We'll use *${email}* for future payments.`,
    { parse_mode: "Markdown" },
  );

  try {
    const { authorization_url, reference } = await initializeTransaction(telegramId, email);
    ctx.session.pendingPaystackRef = reference;
    await ctx.reply(
      `Paystack link ready ✅\n\nReference: \`${reference}\``,
      {
        parse_mode: "Markdown",
        reply_markup: unlockKeyboard(authorization_url),
      },
    );
  } catch (err) {
    console.error("[payments] initializeTransaction after email capture failed:", err);
    captureReplayError(telegramId, err, "handlePaymentEmailText:init", ctx.chat?.id);
    await ctx.reply("I couldn't generate a payment link right now. Please try again in a moment.");
  }

  return true;
}
