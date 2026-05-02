import { InlineKeyboard } from "grammy";
import type { BotContext } from "./types";

export function buildAiComparisonKeyboard(): InlineKeyboard {
  return new InlineKeyboard()
    .text("✨ Save AI Version", "save_ai_log")
    .text("📝 Save My Original", "save_raw_log");
}

export function stageAiComparison(ctx: BotContext, rawText: string, refinedText: string): void {
  ctx.session.pendingRawText = rawText;
  ctx.session.pendingRefinedText = refinedText;
  ctx.session.pendingRefinedContent = undefined;
}

export async function showAiComparisonChoice(
  ctx: BotContext,
  messageId: number,
  rawText: string,
  refinedText: string,
): Promise<void> {
  stageAiComparison(ctx, rawText, refinedText);

  await ctx.api.editMessageText(
    ctx.chat!.id,
    messageId,
    `📝 **Your Raw Log:**\n${rawText}\n\n✨ **Wisa's Refined Log:**\n${refinedText}`,
    {
      parse_mode: "Markdown",
      reply_markup: buildAiComparisonKeyboard(),
    },
  );
}