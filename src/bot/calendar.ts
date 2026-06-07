import { InlineKeyboard } from "grammy";
import {
  startOfMonth,
  endOfMonth,
  eachDayOfInterval,
  getDay,
  format,
  addMonths,
  subMonths,
  isSameDay,
  isBefore,
  startOfDay,
  addDays,
  parseISO,
} from "date-fns";
import { prisma } from "../lib/prisma";
import type { BotContext } from "./types";

// ---------------------------------------------------------------------------
// Calendar keyboard builder
// ---------------------------------------------------------------------------

/**
 * Builds an inline calendar keyboard for the given month.
 *
 * @param year          Full year, e.g. 2026
 * @param month         0-based month index (Jan = 0 … Dec = 11)
 * @param logDates      Dates that already have a log — displayed as "✅ DD"
 * @param scheduledDates  Dates the user was _scheduled_ to log but didn't — displayed as "⭐ DD" (gap-highlight mode)
 * @param callbackPrefix  Prefix for date-tap callbacks, default "past_log"
 */
export function buildCalendarKeyboard(
  year: number,
  month: number,
  logDates: Date[],
  scheduledDates: Date[] = [],
  callbackPrefix = "past_log",
  navPrefix = "cal_nav",
): InlineKeyboard {
  const kb = new InlineKeyboard();

  const base = new Date(year, month, 1);
  const prev = subMonths(base, 1);
  const next = addMonths(base, 1);
  const now = startOfDay(new Date());

  // ── Navigation row ────────────────────────────────────────────────────────
  const prevLabel = `◀️ ${format(prev, "MMM")}`;
  const nextLabel = `${format(next, "MMM")} ▶️`;
  const headerLabel = format(base, "MMMM yyyy");

  kb.text(prevLabel, `${navPrefix}_${prev.getFullYear()}_${prev.getMonth()}`);
  kb.text(headerLabel, "cal_noop");
  kb.text(nextLabel, `${navPrefix}_${next.getFullYear()}_${next.getMonth()}`);
  kb.row();

  // ── Day-of-week headers (Sun–Sat) ─────────────────────────────────────────
  for (const dow of ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"]) {
    kb.text(dow, "cal_noop");
  }
  kb.row();

  // ── Date grid ─────────────────────────────────────────────────────────────
  const firstDay = startOfMonth(base);
  const lastDay = endOfMonth(base);
  const days = eachDayOfInterval({ start: firstDay, end: lastDay });

  // Leading blanks so the first day falls in the right column (0 = Sun)
  let col = getDay(firstDay);
  for (let i = 0; i < col; i++) kb.text(" ", "cal_noop");

  for (const day of days) {
    const dd = format(day, "d");
    const isoDate = format(day, "yyyy-MM-dd");
    const hasLog = logDates.some((d) => isSameDay(d, day));
    const isScheduledGap = !hasLog && scheduledDates.some((d) => isSameDay(d, day));
    const isFuture = !isBefore(day, now) && !isSameDay(day, now);

    let label: string;
    let cbData: string;

    if (isFuture) {
      // Future dates are not tappable
      label = dd;
      cbData = "cal_noop";
    } else if (hasLog) {
      label = `✅`;
      cbData = `${callbackPrefix}_${isoDate}`;
    } else if (isScheduledGap) {
      label = `⭐`;
      cbData = `${callbackPrefix}_${isoDate}`;
    } else {
      label = dd;
      cbData = `${callbackPrefix}_${isoDate}`;
    }

    kb.text(label, cbData);

    col++;
    if (col % 7 === 0) {
      kb.row();
      col = 0;
    }
  }

  return kb;
}

// ---------------------------------------------------------------------------
// Scheduled-date generator (gap-highlight helper)
// ---------------------------------------------------------------------------

/**
 * Generates the dates a user _should_ have logged between `from` and `to`
 * based on their `logFrequency` and the anchor date they chose (createdAt).
 */
export function getScheduledDates(
  from: Date,
  to: Date,
  logFrequency: string,
  anchor: Date,
): Date[] {
  const intervalDays =
    (
      {
        daily: 1,
        "bi-daily": 2,
        "every-3-days": 3,
        weekly: 7,
      } as Record<string, number>
    )[logFrequency] ?? 1;

  const result: Date[] = [];
  let cursor = startOfDay(anchor);

  // Walk cursor forward until it's inside [from, to]
  while (isBefore(cursor, startOfDay(from))) {
    cursor = addDays(cursor, intervalDays);
  }

  while (!isBefore(startOfDay(to), cursor)) {
    result.push(new Date(cursor));
    cursor = addDays(cursor, intervalDays);
  }

  return result;
}

// ---------------------------------------------------------------------------
// 7.1/7.2 — "📅 Calendar" view: browse logs, tap to read
// ---------------------------------------------------------------------------

/**
 * Shows the log-view calendar for the given (or current) month.
 * Only logged days bear a tappable `view_cal_YYYY-MM-DD` callback.
 */
export async function showViewCalendar(
  ctx: BotContext,
  year?: number,
  month?: number,
  opts?: { mode?: "auto" | "reply" | "edit" },
): Promise<void> {
  const telegramId = BigInt(ctx.from!.id);
  const dbUser = await prisma.user.findUnique({ where: { telegramId } });
  if (!dbUser) {
    await ctx.reply("Couldn't find your account. Try /start.");
    return;
  }

  const now = new Date();
  const y = year ?? ctx.session.viewCalYear ?? now.getFullYear();
  const m = month ?? ctx.session.viewCalMonth ?? now.getMonth();

  ctx.session.viewCalYear = y;
  ctx.session.viewCalMonth = m;

  const monthStart = startOfMonth(new Date(y, m, 1));
  const monthEnd = endOfMonth(monthStart);

  const logs = await prisma.log.findMany({
    where: { userId: dbUser.id, logDate: { gte: monthStart, lte: monthEnd } },
    select: { logDate: true },
  });

  const logDates = logs.map((l) => l.logDate);

  // View calendar: no gap-highlight, use vcal_nav for navigation
  const kb = buildCalendarKeyboard(y, m, logDates, [], "view_cal", "vcal_nav");

  const headerText =
    `🗓️ *${format(new Date(y, m, 1), "MMMM yyyy")}*\n\n` +
    `✅ = has a log  Tap a day to read it.`;

  const mode = opts?.mode ?? "auto";
  const shouldEdit = mode === "edit" || (mode === "auto" && Boolean(ctx.callbackQuery));

  if (ctx.callbackQuery) {
    await ctx.answerCallbackQuery().catch(() => {});
  }

  if (shouldEdit) {
    await ctx
      .editMessageText(headerText, { parse_mode: "Markdown", reply_markup: kb })
      .catch(() => ctx.reply(headerText, { parse_mode: "Markdown", reply_markup: kb }));
  } else {
    await ctx.reply(headerText, { parse_mode: "Markdown", reply_markup: kb });
  }
}

/**
 * Navigation handler for the view calendar: callback `vcal_nav_YYYY_M`
 */
export async function handleViewCalNav(ctx: BotContext): Promise<void> {
  const data = ctx.callbackQuery?.data ?? "";
  // format: vcal_nav_2026_2
  const parts = data.split("_");
  const year = parseInt(parts[2], 10);
  const month = parseInt(parts[3], 10);
  await showViewCalendar(ctx, year, month);
}

/**
 * Tapping a logged day in the view calendar: callback `view_cal_YYYY-MM-DD`
 * Shows the log text with [✏️ Edit] [🗑️ Delete] [✨ Refine] [🏠 Menu] buttons.
 * ✅ CRASH-PROOF: Early answerCallbackQuery, full try/catch, safe date parsing.
 */
export async function handleViewCalDateSelect(ctx: BotContext): Promise<void> {
  // ✅ EARLY CALLBACK ANSWER: Stop button loading animation immediately
  await ctx.answerCallbackQuery().catch(() => {});

  try {
    const data = ctx.callbackQuery?.data ?? "";
    const isoDate = data.replace("view_cal_", "");

    // ✅ SAFE DATE PARSING: Validate date strictly before using it
    let parsedDate: Date;
    try {
      parsedDate = parseISO(isoDate);
      // Validate that the parsed date is actually valid
      if (isNaN(parsedDate.getTime())) {
        await ctx.reply("⚠️ Invalid date selected. Please try again.");
        return;
      }
    } catch {
      await ctx.reply("⚠️ Sorry, that date couldn't be parsed. Please try again.");
      return;
    }

    const telegramId = BigInt(ctx.from!.id);

    const dbUser = await prisma.user.findUnique({ where: { telegramId } });
    if (!dbUser) {
      await ctx.reply("Couldn't find your account. Try /start.");
      return;
    }

    const dayStart = startOfDay(parsedDate);
    const dayEnd = new Date(dayStart.getTime() + 86_400_000 - 1);

    const log = await prisma.log.findFirst({
      where: { userId: dbUser.id, logDate: { gte: dayStart, lte: dayEnd } },
      orderBy: { createdAt: "desc" },
    });

    if (!log) {
      await ctx.reply(
        `No log found for ${format(parsedDate, "EEEE, MMM d")}. Want to write one?`,
        {
          reply_markup: new InlineKeyboard()
            .text("✍️ Write log", `past_log_${isoDate}`)
            .text("🏠 Menu", "nav_menu"),
        },
      );
      return;
    }

    await viewLogWithNavigation(ctx, log, dbUser.id);
  } catch (error) {
    console.error("[calendar] View log date select error:", error);
    await ctx.reply("⚠️ Sorry, I ran into an error fetching that log. Please try again.").catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// 7.2b — Pagination helpers for chronological navigation
// ---------------------------------------------------------------------------

/**
 * Get the previous and next logs for a given log ID (chronologically).
 */
export async function getPreviousAndNextLogs(userId: number, currentLog: { logDate: Date }): Promise<{ prev: any | null; next: any | null }> {
  const [prevLog, nextLog] = await Promise.all([
    // Previous log: logDate < current, ordered by logDate DESC (most recent before current)
    prisma.log.findFirst({
      where: {
        userId,
        logDate: { lt: currentLog.logDate },
      },
      orderBy: { logDate: "desc" },
      select: { id: true, logDate: true },
    }),
    // Next log: logDate > current, ordered by logDate ASC (nearest after current)
    prisma.log.findFirst({
      where: {
        userId,
        logDate: { gt: currentLog.logDate },
      },
      orderBy: { logDate: "asc" },
      select: { id: true, logDate: true },
    }),
  ]);

  return { prev: prevLog, next: nextLog };
}

/**
 * Build the view log keyboard with chronological navigation.
 */
export function buildViewLogKeyboard(logId: number, prev: any | null, next: any | null): InlineKeyboard {
  const kb = new InlineKeyboard();

  // Navigation row at the top
  const prevButton = prev ? `◀️ ${format(prev.logDate, "MMM d")}` : "⛔";
  const nextButton = next ? `${format(next.logDate, "MMM d")} ▶️` : "⛔";
  const prevCb = prev ? `view_log_nav_${prev.id}` : "noop";
  const nextCb = next ? `view_log_nav_${next.id}` : "noop";

  kb.text(prevButton, prevCb).text(nextButton, nextCb).row();

  // Main action row
  kb.text("✏️ Edit this log", `edit_log_${logId}`)
    .text("🗑️ Delete", `delete_log_${logId}`)
    .row()
    .text("✨ Refine with AI", `ai_refine_${logId}`)
    .text("🏠 Menu", "nav_menu");

  return kb;
}

/**
 * Display a log with chronological navigation buttons (Prev/Next).
 * ✅ CRASH-PROOF: Full try/catch, safe queries, error handling.
 */
export async function viewLogWithNavigation(ctx: BotContext, log: any, userId: number): Promise<void> {
  try {
    // ✅ SAFE ADJACENT QUERIES: No errors if prev/next don't exist
    const { prev, next } = await getPreviousAndNextLogs(userId, log);
    const keyboard = buildViewLogKeyboard(log.id, prev, next);

    const dateLabel = format(log.logDate, "EEEE, MMMM d yyyy");
    const wordCount = log.content.split(/\s+/).filter(Boolean).length;
    const preview =
      log.refinedContent ??
      (log.content.length > 1000
        ? log.content.slice(0, 1000) + "…"
        : log.content);

    const caption =
      `📖 *Log — ${dateLabel}*\n` +
      `_(${wordCount} words${log.isVoice ? " · 🎤 voice" : ""})_\n\n` +
      preview;

    await ctx.reply(caption, {
      parse_mode: "Markdown",
      reply_markup: keyboard,
    });
  } catch (error) {
    console.error("[calendar] viewLogWithNavigation error:", error);
    await ctx.reply("⚠️ Sorry, I ran into an error displaying that log. Please try again.").catch(() => {});
  }
}

/**
 * Handle navigation between logs (Prev/Next buttons).
 * Callback: `view_log_nav_<id>`
 * ✅ CRASH-PROOF: Early answerCallbackQuery, full try/catch, safe queries.
 */
export async function handleViewLogNavigation(ctx: BotContext): Promise<void> {
  // ✅ EARLY CALLBACK ANSWER: Stop button loading animation immediately
  await ctx.answerCallbackQuery().catch(() => {});

  try {
    const data = ctx.callbackQuery?.data ?? "";
    const logId = parseInt(data.replace("view_log_nav_", ""), 10);

    // ✅ SAFE PARSING: Validate logId before using it
    if (isNaN(logId) || logId <= 0) {
      await ctx.reply("⚠️ Invalid log ID. Please try again.").catch(() => {});
      return;
    }

    const telegramId = BigInt(ctx.from!.id);
    const dbUser = await prisma.user.findUnique({ where: { telegramId } });
    if (!dbUser) {
      await ctx.reply("Couldn't find your account. Try /start.").catch(() => {});
      return;
    }

    // ✅ SAFE QUERY: Fetch the log, handle null gracefully
    const log = await prisma.log.findUnique({
      where: { id: logId },
    });

    if (!log || log.userId !== dbUser.id) {
      await ctx.answerCallbackQuery("Log not found").catch(() => {});
      return;
    }

    // ✅ SAFE ADJACENT QUERIES: No errors if prev/next don't exist (returns null)
    const { prev, next } = await getPreviousAndNextLogs(dbUser.id, log);
    const keyboard = buildViewLogKeyboard(log.id, prev, next);

    const dateLabel = format(log.logDate, "EEEE, MMMM d yyyy");
    const wordCount = log.content.split(/\s+/).filter(Boolean).length;
    const preview =
      log.refinedContent ??
      (log.content.length > 1000
        ? log.content.slice(0, 1000) + "…"
        : log.content);

    const caption =
      `📖 *Log — ${dateLabel}*\n` +
      `_(${wordCount} words${log.isVoice ? " · 🎤 voice" : ""})_\n\n` +
      preview;

    // Edit the current message with the new log
    await ctx
      .editMessageText(caption, {
        parse_mode: "Markdown",
        reply_markup: keyboard,
      })
      .catch(() => {});
  } catch (error) {
    console.error("[calendar] View log navigation error:", error);
    await ctx.reply("⚠️ Sorry, I ran into an error navigating logs. Please try again.").catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// 7.3 — Delete confirmation
// ---------------------------------------------------------------------------

/**
 * First tap on 🗑️ Delete: ask for confirmation.
 * Callback: `delete_log_<id>`
 */
export async function handleDeleteLogPrompt(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();

  const data = ctx.callbackQuery?.data ?? "";
  const logId = data.replace("delete_log_", "");

  await ctx.reply(
    "Are you sure you want to delete this log? This cannot be undone. 🗑️",
    {
      reply_markup: new InlineKeyboard()
        .text("Yes, delete ❌", `delete_confirm_${logId}`)
        .text("Cancel", "delete_cancel"),
    },
  );
}

/**
 * Confirmed deletion.
 * Callback: `delete_confirm_<id>`
 */
export async function handleDeleteLogConfirm(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();

  const data = ctx.callbackQuery?.data ?? "";
  const logId = parseInt(data.replace("delete_confirm_", ""), 10);
  const telegramId = BigInt(ctx.from!.id);

  try {
    const dbUser = await prisma.user.findUnique({ where: { telegramId }, select: { id: true } });
    if (!dbUser) {
      await ctx.reply("Couldn't find your account. Try /start.");
      return;
    }

    const log = await prisma.log.findUnique({ where: { id: logId }, select: { id: true, userId: true } });
    if (!log || log.userId !== dbUser.id) {
      await ctx.reply("That log does not exist or does not belong to you.");
      return;
    }

    await prisma.$transaction([
      prisma.log.delete({ where: { id: logId } }),
      prisma.user.update({
        where: { id: dbUser.id },
        data: { logCount: { decrement: 1 } },
      }),
    ]);

    await ctx.editMessageText("Deleted! 🗑️ Log removed successfully.").catch(() => {});
    await ctx.reply("Log deleted. 👋", {
      reply_markup: new InlineKeyboard()
        .text("📅 View calendar", "nav_calendar")
        .text("🏠 Menu", "nav_menu"),
    });
  } catch {
    await ctx.reply("Couldn't delete that log — it may have already been removed.");
  }
}

/**
 * Cancelled deletion.
 * Callback: `delete_cancel`
 */
export async function handleDeleteLogCancel(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery("Cancelled ✅");
  await ctx.editMessageText("No worries — log kept! 👍").catch(() => {});
}
