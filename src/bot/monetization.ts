import { InlineKeyboard } from "grammy";
import { prisma } from "../lib/prisma";
import type { BotContext } from "./types";

export const FREE_LOG_LIMIT = 20;
export const STORAGE_PRICE_LABEL = "₦1,000/month";

export type MonetizationUser = {
  id: number;
  firstName: string;
  isPro: boolean;
  storageUnlocked: boolean;
  logCount: number;
  nextRenewalDate: Date | null;
};

export function hasActiveStorage(user: MonetizationUser, now = new Date()): boolean {
  if (!user.storageUnlocked) return false;
  if (!user.nextRenewalDate) return true;
  return user.nextRenewalDate >= now;
}

export async function enforceAccessWindow(user: MonetizationUser): Promise<MonetizationUser> {
  if (!user.storageUnlocked || !user.nextRenewalDate) return user;
  if (user.nextRenewalDate >= new Date()) return user;

  const updated = await prisma.user.update({
    where: { id: user.id },
    data: {
      storageUnlocked: false,
      isPro: false,
    },
    select: {
      id: true,
      firstName: true,
      isPro: true,
      storageUnlocked: true,
      logCount: true,
      nextRenewalDate: true,
    },
  });

  return updated;
}

export async function syncUserLogCount(userId: number): Promise<number> {
  const count = await prisma.log.count({ where: { userId } });
  await prisma.user.update({
    where: { id: userId },
    data: { logCount: count },
  });
  return count;
}

export function canCreateLog(user: MonetizationUser): boolean {
  if (hasActiveStorage(user)) return true;
  return user.logCount < FREE_LOG_LIMIT;
}

export function getStorageLimitReachedAfterSaveText(): string {
  return (
    `🎉 Log saved! You're on a roll - ${FREE_LOG_LIMIT} logs and counting 💪\n\n` +
    `---\n\n` +
    `📦 *Your free storage is now full.*\n\n` +
    `I really want to keep storing your logs - you've built something worth keeping here.\n\n` +
    `To keep going, unlock more storage for just *${STORAGE_PRICE_LABEL}* and you'll also get:\n` +
    `🎙️ Unlimited voice logs\n` +
    `✨ Unlimited AI refinements\n\n` +
    `That's everything. No hidden charges, no tiers. Just ₦1,000 and Wisa is fully yours 🙏`
  );
}

export function getStorageWallText(user: MonetizationUser): string {
  return (
    `📦 *Storage full, ${user.firstName}.*\n\n` +
    `I've got everything you've written so far - all *${user.logCount} logs* are safe and you can read them anytime.\n\n` +
    `But I can't store today's log until you unlock more storage.\n\n` +
    `It's *${STORAGE_PRICE_LABEL}* for the whole month - and honestly for what you get, it's a steal 🙏`
  );
}

export async function sendStorageWall(ctx: BotContext, user: MonetizationUser): Promise<void> {
  await ctx.reply(getStorageWallText(user), {
    parse_mode: "Markdown",
    reply_markup: new InlineKeyboard().text("🔓 Unlock storage - ₦1,000", "go_pro"),
  });
}

export async function getMonetizationUserByTelegramId(telegramId: bigint): Promise<MonetizationUser | null> {
  const user = await prisma.user.findUnique({
    where: { telegramId },
    select: {
      id: true,
      firstName: true,
      isPro: true,
      storageUnlocked: true,
      logCount: true,
      nextRenewalDate: true,
    },
  });

  if (!user) return null;
  return enforceAccessWindow(user);
}
