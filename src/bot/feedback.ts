import { InlineKeyboard } from "grammy";
import { type BotContext } from "./types";
import { MAIN_MENU_KEYBOARD } from "./onboarding";

// ---------------------------------------------------------------------------
// Creator Telegram ID — set CREATOR_TELEGRAM_ID in your Railway / .env
// Replace with your numeric Telegram user ID for guaranteed delivery.
// ---------------------------------------------------------------------------
const CREATOR_ID = process.env.CREATOR_TELEGRAM_ID ?? ""; // e.g. "123456789"

// ---------------------------------------------------------------------------
// "💬 Leave feedback" reply keyboard handler
// ---------------------------------------------------------------------------

export async function handleFeedback(ctx: BotContext): Promise<void> {
  ctx.session.awaitingFeedback = true;

  await ctx.reply(
    "💬 *I'm all ears!*\n\n" +
      "What's on your mind? A suggestion, a bug, a vibe check - whatever it is, " +
      "send it and I'll make sure it reaches the creator directly 🙏\n\n" +
      "_Send your message below_ 👇",
    {
      parse_mode: "Markdown",
      reply_markup: new InlineKeyboard().text("❌ Cancel", "feedback_cancel"),
    },
  );
}

// ---------------------------------------------------------------------------
// Text message handler — call from the main message:text router
// Returns true if the message was consumed by the feedback flow.
// ---------------------------------------------------------------------------

export async function handleFeedbackText(ctx: BotContext): Promise<boolean> {
  if (!ctx.session.awaitingFeedback) return false;

  ctx.session.awaitingFeedback = false;

  const text = ctx.message?.text ?? "";
  const sender = ctx.from;
  const senderName = sender?.first_name ?? "Unknown";
  const senderUsername = sender?.username ? `@${sender.username}` : "no username";
  const senderId = sender?.id ?? 0;

  // ── Forward to creator ───────────────────────────────────────────────────
  if (CREATOR_ID) {
    try {
      await ctx.api.sendMessage(
        CREATOR_ID,
        `📩 *New feedback from ${senderName}* (${senderUsername} · \`${senderId}\`)\n\n${text}`,
        { parse_mode: "Markdown" },
      );
      console.log(`[feedback] Forwarded from user ${senderId} (${senderUsername}): ${text}`);
    } catch (err) {
      console.error("[feedback] Failed to forward message to creator:", err);
    }
  } else {
    console.warn("[feedback] CREATOR_TELEGRAM_ID not set — cannot forward feedback.");
    console.log(`[feedback] Received feedback from user ${senderId}: ${text}`);
  }

  await ctx.reply(
    "✅ *Feedback sent!* Thank you so much 🙏\n\n" +
      "Your message is on its way to the creator. " +
      "We read every single one and it helps us make Wisa better for you 💪",
    {
      parse_mode: "Markdown",
      reply_markup: MAIN_MENU_KEYBOARD,
    },
  );

  return true;
}

// ---------------------------------------------------------------------------
// Cancel callback
// ---------------------------------------------------------------------------

export async function handleFeedbackCancel(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();
  ctx.session.awaitingFeedback = false;

  await ctx.editMessageText("No worries! Back to the main menu 😊").catch(() => {});
  await ctx.reply("Main menu 👇", { reply_markup: MAIN_MENU_KEYBOARD });
}
