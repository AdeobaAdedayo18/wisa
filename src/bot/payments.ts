import { InlineKeyboard } from "grammy";
import { type BotContext } from "./types";
import { prisma } from "../lib/prisma";
import { initializeTransaction } from "../services/paystack";

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
        .text("💳 Pay with Paystack", "pay_paystack")
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
