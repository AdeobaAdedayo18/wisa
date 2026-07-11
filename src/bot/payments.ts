import { InlineKeyboard } from "grammy";
import { type BotContext, clearActiveFlow, startFlow, isFlowExpired } from "./types";
import { prisma } from "../lib/prisma";
import { captureReplayError } from "../services/replayCapture";
import { initializeTransaction, verifyTransaction } from "../services/paystack";
import { getMainMenuKeyboard } from "./onboarding";
import { getActiveAutoRenewSubscription, getMonetizationUserByTelegramId, hasActiveStorage, STORAGE_PRICE_LABEL } from "./monetization";
import { parseISO } from "date-fns";
import { nthWorkingDayFrom } from "./catchupFlow";
import { Prisma } from "../prisma/client";

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function alreadySubscribedMessage(nextRenewalDate: Date): string {
  const renewalStr = new Intl.DateTimeFormat("en-GB", {
    weekday: "short",
    day: "numeric",
    month: "short",
    timeZone: "Africa/Lagos",
  }).format(nextRenewalDate);
  return (
    `👑 *You're already subscribed — no need to pay again.*\n\n` +
    `Your Wisa Pro renews automatically on *${renewalStr}* and you'll be charged ₦1,000 then. Nothing to do on your end 🙌\n\n` +
    `Changed your mind about auto-renewal? You can turn it off anytime below — you'll keep Pro until your current month runs out.`
  );
}

async function blockIfAutoRenewActive(
  ctx: BotContext,
  userId: number,
  nextRenewalDate: Date | null,
): Promise<boolean> {
  const managed = await getActiveAutoRenewSubscription(userId, nextRenewalDate);
  if (!managed) return false;
  await ctx.reply(alreadySubscribedMessage(managed.nextRenewalDate), {
    parse_mode: "Markdown",
    reply_markup: new InlineKeyboard().text("⚙️ Manage subscription", "settings_menu"),
  });
  return true;
}

const STORAGE_PERIOD_MS = 30 * 24 * 60 * 60 * 1000;

type SuccessfulCharge = {
  userId: number;
  currentRenewalDate?: Date | null;
  reference: string;
  amount: number;
  currency: string;
  provider: string;
  paidAt: Date;
  metadata?: Prisma.InputJsonValue;
};

export async function activateStorageForUser(
  charge: SuccessfulCharge,
): Promise<{ alreadyProcessed: boolean; newRenewalDate: Date }> {
  const now = new Date();
  const base =
    charge.currentRenewalDate && charge.currentRenewalDate > now
      ? charge.currentRenewalDate.getTime()
      : now.getTime();
  const newRenewalDate = new Date(base + STORAGE_PERIOD_MS);

  const existing = await prisma.paymentTransaction.findUnique({
    where: { reference: charge.reference },
    select: { id: true },
  });
  if (existing) return { alreadyProcessed: true, newRenewalDate };

  try {
    await prisma.$transaction([
      prisma.paymentTransaction.create({
        data: {
          userId: charge.userId,
          amount: charge.amount,
          currency: charge.currency,
          provider: charge.provider,
          reference: charge.reference,
          metadata: charge.metadata,
          paidAt: charge.paidAt,
        },
      }),
      prisma.user.update({
        where: { id: charge.userId },
        data: { isPro: true, storageUnlocked: true, nextRenewalDate: newRenewalDate },
      }),
      prisma.subscription.upsert({
        where: { userId: charge.userId },
        update: { paystackRef: charge.reference, status: "active", endDate: newRenewalDate },
        create: {
          userId: charge.userId,
          paystackRef: charge.reference,
          status: "active",
          startDate: now,
          endDate: newRenewalDate,
        },
      }),
    ]);
  } catch (err) {
    if (err instanceof Prisma.PrismaClientKnownRequestError && err.code === "P2002") {
      const dup = await prisma.paymentTransaction.findUnique({
        where: { reference: charge.reference },
        select: { id: true },
      });
      if (dup) return { alreadyProcessed: true, newRenewalDate };
    }
    throw err;
  }

  return { alreadyProcessed: false, newRenewalDate };
}

function unlockKeyboard(url?: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (url) kb.url("💳 Pay with Paystack", url).row();
  
 
  kb.text("✅ I've paid", "check_payment"); 
  
  return kb;
}

export async function handleGoPro(ctx: BotContext): Promise<void> {
  const telegramId = BigInt(ctx.from!.id);
  const user = await getMonetizationUserByTelegramId(telegramId);
  if (!user) return;

  if (await blockIfAutoRenewActive(ctx, user.id, user.nextRenewalDate)) return;

  // 🚀 BUG FIX: Calculate how many days are left.
  const daysUntilExpiration = user.nextRenewalDate
    ? (user.nextRenewalDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24) 
    : -1;

  // Only block the payment if they have active storage AND are NOT in the 3-day renewal window
  if (hasActiveStorage(user) && daysUntilExpiration > 3) {
    await ctx.reply("🔓 Your storage is already unlocked. You're all set!", {
      reply_markup: getMainMenuKeyboard(true),
    });
    return;
  }

  if (!(await prisma.user.findUnique({ where: { id: user.id }, select: { paymentEmail: true } }))?.paymentEmail) {
    if (ctx.session.awaitingLog && (ctx.session.pendingLogParts?.length ?? 0) > 0) {
      ctx.session.pausedLogDraft = {
        pendingLogParts: [...ctx.session.pendingLogParts],
        pendingLogDate: ctx.session.pendingLogDate,
        lastLogMessageAt: ctx.session.lastLogMessageAt,
        flowStartedAt: ctx.session.flowStartedAt,
        autoSavePromptSent: ctx.session.autoSavePromptSent,
      };
    }

    clearActiveFlow(ctx.session);
    ctx.session.awaitingPaymentEmail = true;
    startFlow(ctx.session);

    await ctx.reply(
      `🔓 *Unlock Wisa Storage*\n\n` +
      `Here's what you get:\n\n` +
      `📊 *Unlimited log storage* — we've got your back\n` +
      `✨ *Unlimited AI refinements* — polish every log entry\n` +
      `🎙️ *Voice logs* — speak your log, we transcribe it\n` +
      `${STORAGE_PRICE_LABEL}\n\n` +
        `Before payment, we need your email to send your receipt, type and send below`,
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

  if (await blockIfAutoRenewActive(ctx, user.id, user.nextRenewalDate)) return;

  const daysUntilExpiration = user.nextRenewalDate
    ? (user.nextRenewalDate.getTime() - Date.now()) / (1000 * 60 * 60 * 24)
    : -1;

  if (user.storageUnlocked && daysUntilExpiration > 3) {
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
        "Payment is not confirmed yet. If you just paid, wait a minute and tap I've paid again.",
      );
      return;
    }

    const paidAt = result.paid_at ? new Date(result.paid_at) : new Date();
    const { alreadyProcessed } = await activateStorageForUser({
      userId: user.id,
      currentRenewalDate: user.nextRenewalDate,
      reference: result.reference,
      amount: result.amount,
      currency: result.currency ?? "NGN",
      provider: "paystack",
      metadata: result.metadata ?? undefined,
      paidAt,
    });

    const catchupState = ctx.session.catchup;
    if (!alreadyProcessed && catchupState?.heldLogs && catchupState.heldLogs.length > 0 && catchupState.startDate) {
      const logsToSave = catchupState.heldLogs;
      const startDate = parseISO(catchupState.startDate);
      const candidateDates = logsToSave.map(log => nthWorkingDayFrom(startDate, log.dateOffset));

      const existingLogs = await prisma.log.findMany({
        where: {
          userId: user.id,
          logDate: { gte: candidateDates[0], lte: candidateDates[candidateDates.length - 1] },
        },
        select: { logDate: true },
      });
      const existingDates = new Set(existingLogs.map(l => l.logDate.toISOString().split('T')[0]));

      const insertData = logsToSave
        .map((log, i) => ({ log, logDate: candidateDates[i] }))
        .filter(({ logDate }) => !existingDates.has(logDate.toISOString().split('T')[0]))
        .map(({ log, logDate }) => ({
          userId: user.id,
          content: log.content,
          isAiRefined: true,
          isVoice: false,
          logDate,
        }));

      const skippedDuplicates = logsToSave.length - insertData.length;

      if (insertData.length > 0) {
        await prisma.$transaction([
          prisma.log.createMany({ data: insertData }),
          prisma.user.update({
            where: { id: user.id },
            data: { logCount: { increment: insertData.length } }
          })
        ]);
      }

      let peekText = `🔓 **Storage Unlocked!**\n\nAs promised, I have successfully saved the remaining **${insertData.length} days** to your logbook:\n\n`;
      insertData.forEach(item => {
        const dateStr = item.logDate.toLocaleDateString('en-GB', { weekday: 'short', month: 'short', day: 'numeric' });
        peekText += `📅 **${dateStr}**\n${item.content}\n\n`;
      });
      if (skippedDuplicates > 0) {
        peekText += `_${skippedDuplicates} day${skippedDuplicates === 1 ? '' : 's'} skipped — you already had logs for those dates._\n\n`;
      }
      peekText += `✅ All caught up!`;

      await ctx.reply(peekText, { parse_mode: "Markdown" });
      ctx.session.catchup = { active: false, step: 'none' };
    }

    // 3. Send normal Pro Welcome Message
    await ctx.reply(
      `👑 *Welcome to the Pro club, ${user.firstName}!*\n\n` +
        `You're all set for the next 30 days 🔓\n\n` +
        `Your logs are flowing again - plus you've got unlimited voice logs and AI refinements now. Go make today's log count 💪`,
      {
        parse_mode: "Markdown",
        reply_markup: new InlineKeyboard().text("✍️ Write today's log", "nav_write"),
      },
    );

    await ctx.reply("🎉 Let's Goo", {
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
    }
  );
}

export async function handleManualSent(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  await ctx.reply(
    "Manual confirmation is no longer supported. Tap below to pay via Paystack.",
    {
      reply_markup: new InlineKeyboard().text("💳 Pay with Paystack", "pay_paystack"),
    }
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


if (email === '/cancel' || email === 'cancel') {
  ctx.session.awaitingPaymentEmail = false;
  ctx.session.pendingPaymentEmail = undefined;
  ctx.session.pendingPaystackRef = undefined;
  await ctx.reply("Payment cancelled. Here's your menu:", {
    reply_markup: getMainMenuKeyboard(false), 
  });
  return true;
}
  // ✅ Safety Check #2: Detect menu button taps and exit gracefully
  const mainMenuPattern = /^(?:✍️\s*Write today.?s log|📖\s*See my logs|💬\s*Leave feedback|✨\s*AI Refine|👑\s*Go Pro|⚙️\s*Settings|🔄\s*Catch up\s*missed days)$/i;
  if (mainMenuPattern.test(email)) {
    ctx.session.awaitingPaymentEmail = false;
    ctx.session.pendingPaymentEmail = undefined;
    ctx.session.pendingPaystackRef = undefined;
    // Let the text handler process the menu button normally
    return false;
  }

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