import { InlineKeyboard } from "grammy";
import { type BotContext, clearActiveFlow, startFlow, isFlowExpired } from "./types";
import { prisma } from "../lib/prisma";
import { captureReplayError } from "../services/replayCapture";
import { initializeTransaction, verifyTransaction } from "../services/paystack";
import { getMainMenuKeyboard } from "./onboarding";
import { getMonetizationUserByTelegramId, hasActiveStorage, STORAGE_PRICE_LABEL } from "./monetization";
import { parseISO, addDays } from "date-fns"; 
import { recordSuccessfulTransaction } from "../services/transactions";

function isValidEmail(email: string): boolean {
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

// 🚀 BUG FIX: Stack the 30 days on top of their remaining time, so paying early doesn't rob them.
export async function activateStorageForUser(userId: number, currentRenewalDate?: Date | null): Promise<void> {
  const now = new Date();
  let newRenewalDate: Date;

  if (currentRenewalDate && currentRenewalDate > now) {
    // They still have time left. Add 30 days to their EXISTING future date.
    newRenewalDate = new Date(currentRenewalDate.getTime() + 30 * 24 * 60 * 60 * 1000);
  } else {
    // They completely expired. Start 30 days from right now.
    newRenewalDate = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  }

  await prisma.user.update({
    where: { id: userId },
    data: {
      isPro: true,
      storageUnlocked: true,
      nextRenewalDate: newRenewalDate,
    },
  });
}

function unlockKeyboard(url?: string): InlineKeyboard {
  const kb = new InlineKeyboard();
  if (url) kb.url("💳 Pay with Paystack", url).row();
  
  // 🚀 ADDED THIS LINE: The missing verification button!
  kb.text("✅ I've paid", "check_payment"); 
  
  return kb;
}

export async function handleGoPro(ctx: BotContext): Promise<void> {
  const telegramId = BigInt(ctx.from!.id);
  const user = await getMonetizationUserByTelegramId(telegramId);
  if (!user) return;

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

    // 1. Activate storage normally (Pass the expiration date so it safely stacks the 30 days)
    await activateStorageForUser(user.id, user.nextRenewalDate);

    try {
      const paidAt = result.paid_at ? new Date(result.paid_at) : new Date();
      await recordSuccessfulTransaction({
        userId: user.id,
        amount: result.amount,
        currency: result.currency ?? "NGN",
        provider: "paystack",
        reference: result.reference,
        metadata: result.metadata ?? null,
        paidAt,
      });
    } catch (recordErr) {
      console.error("[payments] Failed to record transaction:", recordErr);
    }

    // 2. CATCH-UP ENGINE: THE CLIFFHANGER RESOLUTION
    const catchupState = ctx.session.catchup;
    if (catchupState?.heldLogs && catchupState.heldLogs.length > 0 && catchupState.startDate) {
      const logsToSave = catchupState.heldLogs;
      const startDate = parseISO(catchupState.startDate);

      const insertData = logsToSave.map(log => ({
        userId: user.id,
        content: log.content,
        isAiRefined: true,
        isVoice: false,
        logDate: addDays(startDate, log.dateOffset),
      }));

      await prisma.$transaction([
        prisma.log.createMany({ data: insertData }),
        prisma.user.update({
          where: { id: user.id },
          data: { logCount: { increment: logsToSave.length } }
        })
      ]);

      let peekText = `🔓 **Storage Unlocked!**\n\nAs promised, I have successfully saved the remaining **${logsToSave.length} days** to your logbook:\n\n`;
      logsToSave.forEach(log => {
        const logDate = addDays(startDate, log.dateOffset);
        const dateStr = logDate.toLocaleDateString('en-GB', { weekday: 'short', month: 'short', day: 'numeric' });
        peekText += `📅 **${dateStr}**\n${log.content}\n\n`;
      });
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