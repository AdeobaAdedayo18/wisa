import { InlineKeyboard } from "grammy";
import { format, startOfMonth, endOfMonth, parseISO } from "date-fns";
import { prisma } from "../lib/prisma";
import { captureReplayError } from "../services/replayCapture";
import { sendScene } from "../utils/constants";
import { buildCalendarKeyboard, getScheduledDates } from "./calendar";
import type { BotContext } from "./types";
import { clearActiveFlow, startFlow, isFlowExpired } from "./types";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const MAX_WORDS = 1500;
const MAX_CHARS = 10_000;

// ---------------------------------------------------------------------------
// 6.1 — Start logging (today or a chosen past date)
// ---------------------------------------------------------------------------

/**
 * Entry point for the "Write today's log" flow.
 * Call with an optional ISO date string to pre-set a past-log date.
 */
export async function startLogging(ctx: BotContext, isoDate?: string): Promise<void> {
  // Cancel any active flow (feedback, edit, payment, etc.) before starting log
  clearActiveFlow(ctx.session);

  const todayStr = isoDate ?? format(new Date(), "yyyy-MM-dd");
  const isToday = todayStr === format(new Date(), "yyyy-MM-dd");
  const telegramId = BigInt(ctx.from!.id);
  const dbUser = await prisma.user.findUnique({ where: { telegramId } });

  // ── Check for existing log on this date ────────────────────────────────
  if (dbUser) {
    const dateStart = parseISO(todayStr);
    const dateEnd = new Date(dateStart);
    dateEnd.setDate(dateEnd.getDate() + 1);

    const existingLog = await prisma.log.findFirst({
      where: { userId: dbUser.id, logDate: { gte: dateStart, lt: dateEnd } },
      orderBy: { logDate: "desc" },
    });

    if (existingLog) {
      const dateLabel = isToday ? "today" : format(dateStart, "EEEE, MMM d");
      const preview =
        existingLog.content.length > 200
          ? existingLog.content.slice(0, 200) + "…"
          : existingLog.content;

      await ctx.reply(
        `📝 *You already logged ${dateLabel}!*\n\n${preview}\n\nWant to add more or start fresh?`,
        {
          parse_mode: "Markdown",
          reply_markup: new InlineKeyboard()
            .text("➕ Add to this log", `edit_log_${existingLog.id}`)
            .row()
            .text("📱 View in calendar", "nav_calendar")
            .text("🏠 Menu", "nav_menu"),
        },
      );
      return;
    }
  }

  ctx.session.awaitingLog = true;
  ctx.session.pendingLogParts = [];
  ctx.session.pendingLogDate = todayStr;
  ctx.session.editingLogId = undefined;
  ctx.session.awaitingEditText = false;
  startFlow(ctx.session);

  const dateLabel =
    isoDate && isoDate !== format(new Date(), "yyyy-MM-dd")
      ? ` for *${format(parseISO(isoDate), "EEEE, MMM d")}*`
      : " for today";

  await sendScene(
    ctx,
    "scene7",
    `I'm listening 👂\n\nTell me what you worked on${dateLabel}. Send as many messages as you like — I'll put it all together.\n\nTap *Done ✅* when you're finished.\n
    You can also send a voice message instead of typing! Just hit the mic button and talk — Wisa transcribes it automatically 🎤,
    `,
  );

  await ctx.reply("Go ahead — I'm all ears 👇", {
    reply_markup: new InlineKeyboard().text("Done ✅", "done_log"),
  });
}

// ---------------------------------------------------------------------------
// 6.2 — Append incoming text parts while awaitingLog = true
// ---------------------------------------------------------------------------

/**
 * Call this from a `bot.on("message:text")` handler.
 * Returns `true` if the message was consumed (session was in log-writing mode).
 */
export async function handleLogText(ctx: BotContext): Promise<boolean> {
  if (!ctx.session.awaitingLog) return false;
  if (isFlowExpired(ctx.session)) return false;

  const text = ctx.message?.text ?? "";
  if (!text.trim()) return true; // ignore blank messages but still consume them

  ctx.session.pendingLogParts.push(text);

  // Acknowledge without sending a new Done button each time
  await ctx.react("👍").catch(() => {
    // react may not be available if the client is old — silently skip
  });

  return true;
}

// ---------------------------------------------------------------------------
// 6.2 — "Done ✅" callback: assemble, validate, and save
// ---------------------------------------------------------------------------

export async function handleDoneLogging(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();

  if (!ctx.session.awaitingLog || isFlowExpired(ctx.session)) {
    await ctx.reply("No log in progress. Tap *✍️ Write today's log* to start.", {
      parse_mode: "Markdown",
    });
    return;
  }

  const telegramId = BigInt(ctx.from!.id);
  const dbUser = await prisma.user.findUnique({ where: { telegramId } });
  if (!dbUser) {
    await ctx.reply("Couldn't find your account. Try /start.");
    return;
  }

  let fullText = ctx.session.pendingLogParts.join("\n\n").trim();

  if (!fullText) {
    await ctx.reply(
      "You haven't written anything yet! Send me your log first, then tap *Done ✅*.",
      { parse_mode: "Markdown" },
    );
    return;
  }

  // Word-count guard
  const wordCount = fullText.split(/\s+/).filter(Boolean).length;
  if (wordCount > MAX_WORDS) {
    fullText = fullText.slice(0, MAX_CHARS);
    await ctx.reply(
      `⚠️ Your log was over ${MAX_WORDS} words, so I've trimmed it to ~${MAX_CHARS.toLocaleString()} characters. ` +
        `You can edit it afterwards if needed.`,
    );
  }

  // Resolve log date
  const logDate = ctx.session.pendingLogDate
    ? parseISO(ctx.session.pendingLogDate)
    : new Date();

  try {
  const savedLog = await prisma.log.create({
    data: {
      userId: dbUser.id,
      content: fullText,
      logDate,
      isVoice: false,
    },
  });

  console.log(`[log] User ${dbUser.id} saved log #${savedLog.id} — ${fullText.split(/\s+/).filter(Boolean).length} words`);

  // Reset session
  ctx.session.awaitingLog = false;
  ctx.session.pendingLogParts = [];
  ctx.session.pendingLogDate = undefined;
  ctx.session.flowStartedAt = undefined;

  await sendScene(
    ctx,
    "scene8",
    `Log saved! 📖✨\n\nGreat work documenting your day. Keep it up — your future self will thank you 🙌`,
  );

  // Voice hint for free users who still have tries left
  const remainingVoice = dbUser.freeVoiceLogs ?? 3;
  const voiceHint =
    !dbUser.isPro && remainingVoice > 0
      ? `\n\n💡 *Tip:* Did you know you can send a *voice message* instead of typing? Just hit the mic button and talk — Wisa transcribes it automatically! You have *${remainingVoice} free voice log${remainingVoice === 1 ? "" : "s"}* left 🎤`
      : "";

  await ctx.reply(`What would you like to do next?${voiceHint}`, {
    parse_mode: "Markdown",
    reply_markup: new InlineKeyboard()
      .text("✨ Refine with AI", `ai_refine_${savedLog.id}`)
      .row()
      .text("📖 View logs", "nav_calendar")
      .text("🏠 Menu", "nav_menu"),
  });
  } catch (err) {
    console.error("[log] handleDoneLogging error:", err);
    captureReplayError(telegramId, err, "handleDoneLogging", ctx.chat?.id);
    await ctx.reply("Something went wrong saving your log. Please try again 😢");
  }
}

// ---------------------------------------------------------------------------
// 6.3 — Edit an existing log
// ---------------------------------------------------------------------------

/**
 * Callback handler for `edit_log_<id>`.
 * Puts the session in edit mode and waits for the next text message.
 */
export async function handleEditLog(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();

  const data = ctx.callbackQuery?.data ?? "";
  const logId = parseInt(data.replace("edit_log_", ""), 10);

  const log = await prisma.log.findUnique({ where: { id: logId } });
  if (!log) {
    await ctx.reply("Couldn't find that log entry.");
    return;
  }

  clearActiveFlow(ctx.session);
  ctx.session.editingLogId = logId;
  ctx.session.awaitingEditText = true;
  startFlow(ctx.session);

  await ctx.reply(
    `✏️ *Edit mode*\n\n*⚠️ Whatever you type next will completely replace the current log.*\n\nCurrent log (${log.content.split(/\s+/).length} words):\n\n${
      log.content.length > 300 ? log.content.slice(0, 300) + "…" : log.content
    }`,
    { parse_mode: "Markdown" },
  );
}

/**
 * Text handler for log-editing mode.
 * Returns `true` if the message was consumed.
 */
export async function handleEditText(ctx: BotContext): Promise<boolean> {
  if (!ctx.session.awaitingEditText || !ctx.session.editingLogId) return false;
  if (isFlowExpired(ctx.session)) return false;

  const newContent = ctx.message?.text?.trim() ?? "";
  if (!newContent) return true;

  const telegramId = BigInt(ctx.from!.id);
  try {
  await prisma.log.update({
    where: { id: ctx.session.editingLogId },
    data: { content: newContent },
  });

  // Reset edit-mode session flags
  ctx.session.awaitingEditText = false;
  ctx.session.editingLogId = undefined;
  ctx.session.flowStartedAt = undefined;

  await ctx.reply("Updated! ✅ Looking good 👌", {
    reply_markup: new InlineKeyboard()
      .text("✨ Refine with AI", `ai_refine_latest`)
      .text("🏠 Menu", "nav_menu"),
  });
  } catch (err) {
    console.error("[log] handleEditText error:", err);
    captureReplayError(telegramId, err, "handleEditText", ctx.chat?.id);
    await ctx.reply("Couldn't save your edit. Please try again 😢");
  }

  return true;
}

// ---------------------------------------------------------------------------
// 6.4 — Past-log: calendar picker with gap-highlight mode
// ---------------------------------------------------------------------------

/**
 * Shows the past-log calendar for the current (or given) month.
 * Days with logs: ✅  |  Scheduled-but-missed days: ⭐
 */
export async function showPastLogCalendar(
  ctx: BotContext,
  year?: number,
  month?: number,
): Promise<void> {
  const telegramId = BigInt(ctx.from!.id);
  const dbUser = await prisma.user.findUnique({ where: { telegramId } });
  if (!dbUser) {
    await ctx.reply("Couldn't find your account. Try /start.");
    return;
  }

  const now = new Date();
  const y = year ?? ctx.session.pastCalYear ?? now.getFullYear();
  const m = month ?? ctx.session.pastCalMonth ?? now.getMonth();

  // Persist in session for navigation
  ctx.session.pastCalYear = y;
  ctx.session.pastCalMonth = m;

  const monthStart = startOfMonth(new Date(y, m, 1));
  const monthEnd = endOfMonth(monthStart);

  // Fetch logs for this month
  const logs = await prisma.log.findMany({
    where: {
      userId: dbUser.id,
      logDate: { gte: monthStart, lte: monthEnd },
    },
    select: { logDate: true },
  });

  const logDates = logs.map((l) => l.logDate);

  // Compute scheduled dates (gap-highlight)
  const scheduled = getScheduledDates(
    monthStart,
    monthEnd,
    dbUser.logFrequency,
    dbUser.createdAt,
  );

  const kb = buildCalendarKeyboard(y, m, logDates, scheduled);

  const headerText = `🗓️ *${format(new Date(y, m, 1), "MMMM yyyy")}*\n\n✅ = logged  ⭐ = missed  Tap a day to write a past log.`;

  if (ctx.callbackQuery) {
    await ctx.editMessageText(headerText, {
      parse_mode: "Markdown",
      reply_markup: kb,
    }).catch(() =>
      ctx.reply(headerText, { parse_mode: "Markdown", reply_markup: kb }),
    );
    await ctx.answerCallbackQuery();
  } else {
    await ctx.reply(headerText, { parse_mode: "Markdown", reply_markup: kb });
  }
}

/**
 * Callback handler for calendar navigation: `cal_nav_YYYY_M`
 */
export async function handlePastCalNav(ctx: BotContext): Promise<void> {
  const data = ctx.callbackQuery?.data ?? "";
  // format: cal_nav_2026_2
  const parts = data.split("_");
  const year = parseInt(parts[2], 10);
  const month = parseInt(parts[3], 10);
  await showPastLogCalendar(ctx, year, month);
}

/**
 * Callback handler for a date tap in the past-log calendar: `past_log_YYYY-MM-DD`
 */
export async function handlePastLogDateSelect(ctx: BotContext): Promise<void> {
  await ctx.answerCallbackQuery();

  const data = ctx.callbackQuery?.data ?? "";
  const isoDate = data.replace("past_log_", "");

  // Dismiss the calendar
  await ctx.editMessageReplyMarkup({ reply_markup: { inline_keyboard: [] } }).catch(() => {});

  await startLogging(ctx, isoDate);
}
