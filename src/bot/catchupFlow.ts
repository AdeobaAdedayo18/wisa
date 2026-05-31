import { InlineKeyboard } from "grammy";
import { parseISO, addDays, getDaysInMonth, startOfMonth, getDay, format } from "date-fns";
import { prisma } from "../lib/prisma";
import type { BotContext } from "./types";
import { clearActiveFlow } from "./types";
import { calculateWorkingDays } from "../utils/dateHelpers";
import { evaluateCatchupDetail, generateMultiDayLogs } from "../services/openai";
import { getMonetizationUserByTelegramId, hasActiveStorage, FREE_LOG_LIMIT, canCreateLog, sendStorageWall } from "./monetization";

// ----------------------------------------------------------------------------
// CALENDAR GENERATOR
// ----------------------------------------------------------------------------
export function generateCatchupCalendar(year: number, month: number, mode: 'start' | 'end'): InlineKeyboard {
  const kb = new InlineKeyboard();
  const date = new Date(year, month);
  
  // Row 1: Header
  const title = `${format(date, 'MMMM yyyy')} - ${mode === 'start' ? '🟢 Start Date' : '🔴 End Date'}`;
  kb.text(title, "ccal_noop").row();

  // Row 2: Days of the week
  const days = ['S', 'M', 'T', 'W', 'T', 'F', 'S'];
  days.forEach(d => kb.text(d, "ccal_noop"));
  kb.row();

  // Row 3+: The actual dates
  const startingDayOfWeek = getDay(startOfMonth(date)); // 0 = Sunday
  const daysInMonth = getDaysInMonth(date);

  let currentColumn = 0;
  for (let i = 0; i < startingDayOfWeek; i++) {
    kb.text(" ", "ccal_noop");
    currentColumn++;
  }

  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = `${year}-${String(month + 1).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    kb.text(String(day), `ccal_sel_${mode}_${dateStr}`);
    
    currentColumn++;
    if (currentColumn === 7) {
      kb.row();
      currentColumn = 0;
    }
  }

  if (currentColumn > 0 && currentColumn < 7) {
    for (let i = currentColumn; i < 7; i++) {
      kb.text(" ", "ccal_noop");
    }
    kb.row();
  }

  // Navigation Row: < Prev | Cancel | Next >
  const prevMonth = month === 0 ? 11 : month - 1;
  const prevYear = month === 0 ? year - 1 : year;
  const nextMonth = month === 11 ? 0 : month + 1;
  const nextYear = month === 11 ? year + 1 : year;

  kb.text("◀️ Prev", `ccal_nav_${mode}_${prevYear}_${prevMonth}`);
  kb.text("❌ Cancel", "ccal_cancel");
  kb.text("Next ▶️", `ccal_nav_${mode}_${nextYear}_${nextMonth}`);

  return kb;
}

// ----------------------------------------------------------------------------
// DATE HELPERS (used for >20-day split guidance)
// ----------------------------------------------------------------------------

function addWorkingDays(date: Date, n: number): Date {
  let d = new Date(date);
  let counted = 0;
  while (counted < n) {
    d = addDays(d, 1);
    const dow = getDay(d);
    if (dow !== 0 && dow !== 6) counted++;
  }
  return d;
}

function nextWorkingDay(date: Date): Date {
  let d = addDays(date, 1);
  while (getDay(d) === 0 || getDay(d) === 6) d = addDays(d, 1);
  return d;
}

/**
 * Returns the nth working day (Mon–Fri) from startDate.
 * n=0 returns startDate itself (or the next Monday if startDate is a weekend).
 * n=1 returns the next working day after the base; etc.
 */
export function nthWorkingDayFrom(startDate: Date, n: number): Date {
  let base = new Date(startDate);
  const dow = getDay(base);
  if (dow === 6) base = addDays(base, 2); // Sat → Mon
  else if (dow === 0) base = addDays(base, 1); // Sun → Mon
  return addWorkingDays(base, n);
}

// ----------------------------------------------------------------------------
// START UP FLOW
// ----------------------------------------------------------------------------
export async function startCatchupFlow(ctx: BotContext) {
  clearActiveFlow(ctx.session);

  const telegramId = BigInt(ctx.from!.id);

  // Fix 1: Check storage limit before doing anything else
  const monUser = await getMonetizationUserByTelegramId(telegramId);
  if (monUser && !canCreateLog(monUser)) {
    await sendStorageWall(ctx, monUser);
    await ctx.reply("Once you've unlocked storage, run /catchup to try again.");
    return;
  }

  const dbUser = await prisma.user.findUnique({ where: { telegramId } });

  if (dbUser && !dbUser.courseOfStudy) {
    ctx.session.catchup = {
      active: true,
      step: 'awaiting_course',
      questionCount: 0,
      rawDump: undefined,
      heldLogs: undefined,
      startedAt: Date.now(),
    };

    await ctx.reply(
      "Before we start, what's your area of study or department at your placement? 👇\n\n_(e.g. Computer Science, Electrical Engineering, Accounting)_",
      { parse_mode: "Markdown" }
    );
    return;
  }

  await triggerCatchupCalendar(ctx);
}

async function triggerCatchupCalendar(ctx: BotContext) {
  ctx.session.catchup = {
    active: true,
    step: 'awaiting_start_date',
    questionCount: 0,
    rawDump: undefined,
    heldLogs: undefined,
    startedAt: Date.now(),
  };

  const now = new Date();
  const calendarKb = generateCatchupCalendar(now.getFullYear(), now.getMonth(), 'start');

  await ctx.reply(
    "Let's get your logbook caught up. 📅\n\nTap the start date of the period you missed:",
    { reply_markup: calendarKb }
  );
}

// ----------------------------------------------------------------------------
// CALLBACK HANDLER (Handles Calendar Taps)
// ----------------------------------------------------------------------------
export async function handleCatchupCallback(ctx: BotContext) {
  const data = ctx.callbackQuery?.data;
  if (!data) return;
  const state = ctx.session.catchup;

  if (data === "ccal_noop") {
    await ctx.answerCallbackQuery();
    return;
  }

  if (data === "ccal_cancel") {
    clearActiveFlow(ctx.session);
    await ctx.editMessageText("Catch-up cancelled. Let me know when you're ready! 🏠", {
      reply_markup: new InlineKeyboard().text("🏠 Menu", "nav_menu")
    });
    await ctx.answerCallbackQuery();
    return;
  }

  if (data === "catchup_more_detail") {
    if (!state?.active) {
      await ctx.answerCallbackQuery("This flow has expired. Please type /catchup again.");
      return;
    }
    state.step = 'awaiting_more_detail';
    ctx.session.catchup = state;
    await ctx.editMessageText(
      "Tell me more about what you were doing during the rest of that period — rough notes are fine. 📝"
    );
    await ctx.answerCallbackQuery();
    return;
  }

  if (data === "catchup_skip") {
    clearActiveFlow(ctx.session);
    await ctx.editMessageText(
      "No problem — the logs I generated are already in your logbook. 👍",
      { reply_markup: new InlineKeyboard().text("📅 View calendar", "nav_calendar").text("🏠 Menu", "nav_menu") }
    );
    await ctx.answerCallbackQuery();
    return;
  }

  if (!state || !state.active) {
    await ctx.answerCallbackQuery("This flow has expired. Please type /catchup again.");
    return;
  }

  // Handle Month Navigation
  if (data.startsWith("ccal_nav_")) {
    const parts = data.split("_");
    const mode = parts[2] as 'start' | 'end';
    const year = parseInt(parts[3]);
    const month = parseInt(parts[4]);

    const kb = generateCatchupCalendar(year, month, mode);
    await ctx.editMessageReplyMarkup({ reply_markup: kb }).catch(() => {});
    await ctx.answerCallbackQuery();
    return;
  }

  // Handle Date Selection
  if (data.startsWith("ccal_sel_")) {
    // ✅ FIX #1: Use regex to properly extract date (format: ccal_sel_[mode]_[YYYY-MM-DD])
    const match = data.match(/^ccal_sel_(start|end)_(\d{4}-\d{2}-\d{2})$/);
    if (!match) {
      await ctx.answerCallbackQuery("Invalid date selection. Please try again.");
      return;
    }

    const mode = match[1] as 'start' | 'end';
    const selectedDate = match[2];

    if (mode === "start") {
      state.startDate = selectedDate;
      state.step = 'awaiting_end_date';

      const [y, m] = selectedDate.split("-").map(Number);
      const endKb = generateCatchupCalendar(y, m - 1, 'end');

      await ctx.editMessageText(
        `✅ **Start Date:** ${selectedDate}\n\n👇 **Now, tap the END DATE:**`,
        { parse_mode: "Markdown", reply_markup: endKb }
      );
    } 
    else if (mode === "end") {
      state.endDate = selectedDate;
      
      const telegramId = BigInt(ctx.from!.id);
      const timezone = "Africa/Lagos"; 
      const workingDays = calculateWorkingDays(parseISO(state.startDate!), parseISO(state.endDate), timezone);

      if (workingDays === 0) {
        state.endDate = undefined;
        state.step = 'awaiting_end_date';
        ctx.session.catchup = state;

        const [y, m] = state.startDate!.split("-").map(Number);
        const endKb = generateCatchupCalendar(y, m - 1, 'end');

        await ctx.editMessageText(
          "That range is all weekend days — no working days to log. Please pick a range that includes weekdays.",
          { reply_markup: endKb }
        );
        await ctx.answerCallbackQuery();
        return;
      }
      
      // ✅ FIX #8: Provide retry path instead of clearing the flow
      if (workingDays < 0) {
        state.endDate = undefined;  // Clear the invalid end date
        state.step = 'awaiting_end_date';  // Go back to end date selection
        ctx.session.catchup = state;

        const [y, m] = state.startDate!.split("-").map(Number);
        const endKb = generateCatchupCalendar(y, m - 1, 'end');

        await ctx.editMessageText(
          `⚠️ The end date can't be before the start date! \n\n_Please tap the END DATE again (on or after ${state.startDate}):_`,
          { parse_mode: "Markdown", reply_markup: endKb }
        );
        await ctx.answerCallbackQuery("Please select an end date after the start date.");
        return;
      }

      if (workingDays > 20) {
        const startDate = parseISO(state.startDate!);
        const endDate = parseISO(selectedDate);
        const session1End = addWorkingDays(startDate, 20);
        const session2Start = nextWorkingDay(session1End);
        const fmt = (d: Date) => format(d, 'MMM d, yyyy');

        // Reset to start-date picker — keep flow active so the user can tap immediately
        state.step = 'awaiting_start_date';
        state.startDate = undefined;
        state.endDate = undefined;
        ctx.session.catchup = state;

        const [sy, sm] = format(startDate, 'yyyy-MM').split('-').map(Number);
        const startKb = generateCatchupCalendar(sy, sm - 1, 'start');

        await ctx.editMessageText(
          `That's ${workingDays} working days — I can only do 20 at a time.\n\nHere's how to split it:\n• *Session 1:* ${fmt(startDate)} → ${fmt(session1End)}\n• *Session 2:* ${fmt(session2Start)} → ${fmt(endDate)}\n\nStart with Session 1 — tap the dates below when you're ready.`,
          { parse_mode: "Markdown", reply_markup: startKb }
        );
        await ctx.answerCallbackQuery();
        return;
      }

      state.workingDays = workingDays;
      state.step = 'awaiting_braindump';

      await ctx.editMessageText(
        `Got it — ${workingDays} working day${workingDays === 1 ? '' : 's'}. 📝\n\nTell me what you were up to during that period — type it out or just send a voice note. Anything you remember, even rough notes 🎤`
      );
    }
    await ctx.answerCallbackQuery();
  }
}

// ----------------------------------------------------------------------------
// TEXT HANDLER (Handles the Brain-dump text and Gatekeeper)
// ----------------------------------------------------------------------------

/**
 * Core text-processing logic for the catch-up flow.
 * Exported separately so voice transcriptions can be fed in directly without
 * going through ctx.message.text.
 */
export async function handleCatchupFlowWithText(ctx: BotContext, text: string): Promise<void> {
  const state = ctx.session.catchup;

  if (!text || !state) return;

  const CATCHUP_TIMEOUT_MS = 2 * 60 * 60 * 1000;
  if (state.startedAt && Date.now() - state.startedAt > CATCHUP_TIMEOUT_MS) {
    clearActiveFlow(ctx.session);
    await ctx.reply(
      "Your catch-up session expired after 2 hours of inactivity. Type /catchup to start a new one 👇"
    );
    return;
  }

  if (text.toLowerCase() === 'cancel' || text === '/cancel') {
    clearActiveFlow(ctx.session);
    await ctx.reply("Catch-up cancelled. Let me know when you're ready! 🏠", {
      reply_markup: new InlineKeyboard().text("🏠 Menu", "nav_menu")
    });
    return;
  }

  if (/^[^a-zA-Z0-9]*(catch up|fill missed days|catch up missed days)[^a-zA-Z0-9]*$/i.test(text)) {
    return startCatchupFlow(ctx);
  }

  const telegramId = BigInt(ctx.from!.id);

  try {
    switch (state.step) {
      
      case 'awaiting_course': {
        const courseText = text.trim();

        
        if (courseText.length < 2) {
          await ctx.reply("Please enter a valid Course of Study!");
          return;
        }

       
        if (courseText.length > 100) {
          await ctx.reply("Course of Study is too long. Please keep it under 100 characters.");
          return;
        }

        
        const suspiciousPatterns = [
          /[\n\r]/,  // Newlines that could escape the prompt
          /`+/,      // Backticks (markdown code)
          /\$\{/,    // Template literals
          /--/,      // SQL comments
        ];

        for (const pattern of suspiciousPatterns) {
          if (pattern.test(courseText)) {
            await ctx.reply("That doesn't look like a valid course name. Please try again!");
            return;
          }
        }

        // ✅ Only allow alphanumeric, spaces, and common course characters
        if (!/^[a-zA-Z0-9\s&().\-/]+$/.test(courseText)) {
          await ctx.reply("Please use letters and numbers only — no commas or colons. For example: 'Computer Science and Software Engineering' or 'Electrical Engineering'");
          return;
        }

        // ✅ Save it to the database so we never have to ask again
        await prisma.user.update({
          where: { telegramId },
          data: { courseOfStudy: courseText },
        });

        state.step = 'awaiting_start_date';
        state.questionCount = 0;
        ctx.session.catchup = state;

        const now = new Date();
        const calendarKb = generateCatchupCalendar(now.getFullYear(), now.getMonth(), 'start');

        await ctx.reply(
          `Got it — I'll write your logs for *${courseText}*. 📅\n\nTap the start date of the period you missed:`,
          { parse_mode: "Markdown", reply_markup: calendarKb }
        );
        break;
      }

      case 'awaiting_start_date':
      case 'awaiting_end_date': {
        // ✅ SILENT DELETION: Instead of nagging, silently delete stray text to keep chat clean
        await ctx.deleteMessage().catch(() => {});
        break;
      }

      case 'awaiting_braindump':
      case 'interrogation': {
        const workingDays = state.workingDays!;

        if (state.step === 'awaiting_braindump') {
          // Accumulate all messages before evaluating the total — never test a single
          // message in isolation, which caused the infinite "too short" loop.
          state.rawDump = state.rawDump ? `${state.rawDump}\n${text}` : text;
          ctx.session.catchup = state;

          const totalWordCount = state.rawDump.split(/\s+/).filter(Boolean).length;
          if (totalWordCount < 15) {
            await ctx.reply("Got it — tell me a bit more and I'll put it all together 📝");
            return;
          }
        } else {
          // interrogation: user answered follow-up questions — accumulate and proceed
          state.rawDump = `${state.rawDump ?? ''}\n\nUser added: ${text}`;
          ctx.session.catchup = state;
        }

        const loadingMsg = await ctx.reply("⏳");

        let isProcessing = true;
        const typingInterval = setInterval(() => {
          if (isProcessing) ctx.api.sendChatAction(ctx.chat!.id, "typing").catch(() => {});
        }, 4000);

        try {
          const dbUser = await prisma.user.findUnique({ where: { telegramId } });
          const courseOfStudy = dbUser?.courseOfStudy ?? "IT";

          const evaluation = await evaluateCatchupDetail(state.rawDump, workingDays, courseOfStudy);

          // From 'interrogation': one round of questions already happened — force proceed
          const isAdequate = state.step === 'interrogation' ? true : evaluation.isAdequate;
          const isInterrogationFallback = state.step === 'interrogation' && evaluation.maxSupportableDays === 0;
          const maxSupportableDays = isInterrogationFallback
            ? Math.min(5, workingDays)
            : (evaluation.maxSupportableDays > 0 ? evaluation.maxSupportableDays : workingDays);

          if (!isAdequate) {
            state.step = 'interrogation';
            ctx.session.catchup = state;
            isProcessing = false;
            clearInterval(typingInterval);

            const formattedQuestions = evaluation.followUpQuestions.map(q => `• ${q}`).join('\n');

            await ctx.api.editMessageText(
              ctx.chat!.id,
              loadingMsg.message_id,
              `I need a bit more to work with. 🤔\n\n${formattedQuestions}\n\n_(A rough reply is fine — just give me the gist)_`,
              { parse_mode: "Markdown" }
            );
            return;
          }

          const cappedWorkingDays = Math.min(maxSupportableDays, workingDays);
          const localOriginalDays = workingDays;
          const localWasCapped = cappedWorkingDays < localOriginalDays;

          if (isInterrogationFallback) {
            await ctx.api.editMessageText(
              ctx.chat!.id,
              loadingMsg.message_id,
              "I don't have much to work with, but I'll generate a few days based on your area of interest. You can always edit them from your calendar after."
            );
          } else if (localWasCapped) {
            await ctx.api.editMessageText(
              ctx.chat!.id,
              loadingMsg.message_id,
              `Your notes cover about *${cappedWorkingDays} days* realistically. Generating those now — give me a moment. ✨`,
              { parse_mode: "Markdown" }
            );
          } else {
            await ctx.api.editMessageText(
              ctx.chat!.id,
              loadingMsg.message_id,
              "Got it. Generating your logs now — give me a moment. ✨"
            );
          }

          let progressTimer: ReturnType<typeof setTimeout> | undefined;
          if (cappedWorkingDays >= 10) {
            progressTimer = setTimeout(async () => {
              if (isProcessing) {
                await ctx.reply("Still working on it — longer periods take a bit more time ⏳").catch(() => {});
              }
            }, 20000);
          }

          const generated = await generateMultiDayLogs(state.rawDump, cappedWorkingDays, courseOfStudy);
          if (progressTimer) clearTimeout(progressTimer);

          isProcessing = false;
          clearInterval(typingInterval);

          if (!generated.logs || generated.logs.length === 0) {
            if (ctx.session.catchup) ctx.session.catchup.active = false;
            await ctx.api.deleteMessage(ctx.chat!.id, loadingMsg.message_id).catch(() => {});
            await ctx.reply(
              "I wasn't able to generate any log entries from what you shared 😔\n\nTry giving me a bit more detail about what you worked on and run /catchup again."
            );
            return;
          }

          // Re-fetch user state after AI generation — logCount may have changed
          const freshDbUser = await prisma.user.findUnique({
            where: { telegramId },
            select: { id: true },
          });

          const freshMonUser = await getMonetizationUserByTelegramId(telegramId);
          const freshIsPro = hasActiveStorage(freshMonUser!);
          const freshRemainingQuota = freshIsPro ? 9999 : Math.max(0, FREE_LOG_LIMIT - freshMonUser!.logCount);

          const logsToSave = generated.logs.slice(0, freshRemainingQuota);
          const logsToHold = generated.logs.slice(freshRemainingQuota);

          let skippedDuplicates = 0;
          if (logsToSave.length > 0) {
            const startDateParsed = parseISO(state.startDate!);
            const candidateDates = logsToSave.map(log => nthWorkingDayFrom(startDateParsed, log.dateOffset));

            const existingLogs = await prisma.log.findMany({
              where: {
                userId: freshDbUser!.id,
                logDate: { gte: candidateDates[0], lte: candidateDates[candidateDates.length - 1] },
              },
              select: { logDate: true },
            });
            const existingDates = new Set(existingLogs.map(l => l.logDate.toISOString().split('T')[0]));

            const insertData = logsToSave
              .map((log, i) => ({ log, logDate: candidateDates[i] }))
              .filter(({ logDate }) => !existingDates.has(logDate.toISOString().split('T')[0]))
              .map(({ log, logDate }) => ({
                userId: freshDbUser!.id,
                content: log.content,
                isAiRefined: true,
                isVoice: false,
                logDate,
              }));

            skippedDuplicates = logsToSave.length - insertData.length;

            if (insertData.length > 0) {
              await prisma.$transaction([
                prisma.log.createMany({ data: insertData }),
                prisma.user.update({
                  where: { id: freshDbUser!.id },
                  data: { logCount: { increment: insertData.length } },
                }),
              ]);
            }
          }

          await ctx.api.deleteMessage(ctx.chat!.id, loadingMsg.message_id).catch(() => {});

          if (logsToHold.length > 0) {
            // Paywall hit after generation
            state.heldLogs = logsToHold.map(log => ({
              content: log.content,
              logDate: nthWorkingDayFrom(parseISO(state.startDate!), log.dateOffset).toISOString(),
              dateOffset: log.dateOffset,
            }));
            state.savedLogsCount = logsToSave.length;

            if (freshDbUser) {
              await prisma.user.update({
                where: { id: freshDbUser.id },
                data: { hitPaywall: true },
              });
            }

            let peekText = localWasCapped
              ? `⚠️ Your notes covered *${cappedWorkingDays} days* (out of ${localOriginalDays} requested). Here's a peek:\n\n`
              : `✅ *${cappedWorkingDays} days generated.* Here's a peek:\n\n`;

            generated.logs.slice(0, 2).forEach((log, index) => {
              const logDate = nthWorkingDayFrom(parseISO(state.startDate!), log.dateOffset);
              const dateStr = logDate.toLocaleDateString('en-GB', { weekday: 'short', month: 'short', day: 'numeric' });
              peekText += `📌 *Day ${index + 1}* • _${dateStr}_\n> ${log.content}\n\n`;
            });

            if (generated.logs.length > 2) {
              peekText += `🔒 _...and ${generated.logs.length - 2} more days._\n\n`;
            }

            await ctx.reply(peekText, { parse_mode: "Markdown" });
            await ctx.reply(
              `You've hit your free storage limit.\n\nI saved the first *${logsToSave.length} day${logsToSave.length === 1 ? '' : 's'}* and I'm holding the remaining *${logsToHold.length}*. Unlock Pro for ₦1,000 to save them. 🔓` +
              (skippedDuplicates > 0 ? `\n\n_${skippedDuplicates} day${skippedDuplicates === 1 ? '' : 's'} skipped — you already had logs for those dates._` : ''),
              {
                parse_mode: "Markdown",
                reply_markup: new InlineKeyboard().text("🔓 Unlock Storage - ₦1,000", "go_pro"),
              }
            );
            // Deactivate so further text input doesn't re-trigger generation.
            // heldLogs intentionally preserved for the payment webhook.
            if (ctx.session.catchup) ctx.session.catchup.active = false;
          } else if (localWasCapped) {
            // Fix 4: Honest capping — offer to add more detail for remaining days
            const remainingDays = localOriginalDays - cappedWorkingDays;
            state.cappedAt = cappedWorkingDays;
            state.remainingDays = remainingDays;
            ctx.session.catchup = state;

            let successText = `Based on what you shared, I was able to generate *${cappedWorkingDays} realistic day${cappedWorkingDays === 1 ? '' : 's'}*. The information wasn't detailed enough for the remaining *${remainingDays} day${remainingDays === 1 ? '' : 's'}* — if you can tell me more about what you did during that period, I can fill in the rest.\n\n`;

            generated.logs.slice(0, 2).forEach((log, index) => {
              const logDate = nthWorkingDayFrom(parseISO(state.startDate!), log.dateOffset);
              const dateStr = logDate.toLocaleDateString('en-GB', { weekday: 'short', month: 'short', day: 'numeric' });
              successText += `📌 *Day ${index + 1}* • _${dateStr}_\n> ${log.content}\n\n`;
            });

            if (generated.logs.length > 2) {
              successText += `✨ _...plus ${generated.logs.length - 2} more days._\n\n`;
            }

            if (skippedDuplicates > 0) {
              successText += `_${skippedDuplicates} day${skippedDuplicates === 1 ? '' : 's'} skipped — you already had logs for those dates._\n\n`;
            }

            await ctx.reply(successText, { parse_mode: "Markdown" });
            await ctx.reply("What would you like to do?", {
              reply_markup: new InlineKeyboard()
                .text("📝 Add more details", "catchup_more_detail")
                .text("✅ I'm done", "catchup_skip"),
            });
          } else {
            // Full success
            let successText = `✅ *${cappedWorkingDays} day${cappedWorkingDays === 1 ? '' : 's'} logged!* Here's a quick preview:\n\n`;

            generated.logs.slice(0, 3).forEach((log, index) => {
              const logDate = nthWorkingDayFrom(parseISO(state.startDate!), log.dateOffset);
              const dateStr = logDate.toLocaleDateString('en-GB', { weekday: 'short', month: 'short', day: 'numeric' });
              successText += `📌 *Day ${index + 1}* • _${dateStr}_\n> ${log.content}\n\n`;
            });

            if (generated.logs.length > 3) {
              successText += `✨ _...plus ${generated.logs.length - 3} more days perfectly written._\n\n`;
            }

            if (skippedDuplicates > 0) {
              successText += `_${skippedDuplicates} day${skippedDuplicates === 1 ? '' : 's'} skipped — you already had logs for those dates._\n\n`;
            }

            await ctx.reply(successText, { parse_mode: "Markdown" });
            await ctx.reply("All done — they're in your logbook. 🎉", {
              reply_markup: new InlineKeyboard().text("📅 View calendar", "nav_calendar").text("🏠 Menu", "nav_menu"),
            });

            clearActiveFlow(ctx.session);
          }
        } catch (innerErr) {
          isProcessing = false;
          clearInterval(typingInterval);
          throw innerErr;
        }
        break;
      }

      case 'awaiting_more_detail': {
        // Fix 4: User provided more context for the remaining days
        state.rawDump = `${state.rawDump ?? ''}\n\nMore context: ${text}`;
        const remainingDays = state.remainingDays!;
        const cappedAt = state.cappedAt!;
        ctx.session.catchup = state;

        const loadingMsg = await ctx.reply("Got it. Generating the remaining days — give me a moment. ✨");

        let isProcessing = true;
        const typingInterval = setInterval(() => {
          if (isProcessing) ctx.api.sendChatAction(ctx.chat!.id, "typing").catch(() => {});
        }, 4000);

        try {
          const dbUser = await prisma.user.findUnique({ where: { telegramId } });
          const courseOfStudy = dbUser?.courseOfStudy ?? "IT";

          let progressTimer: ReturnType<typeof setTimeout> | undefined;
          if (remainingDays >= 10) {
            progressTimer = setTimeout(async () => {
              if (isProcessing) {
                await ctx.reply("Still working on it — longer periods take a bit more time ⏳").catch(() => {});
              }
            }, 20000);
          }

          const generated = await generateMultiDayLogs(state.rawDump, remainingDays, courseOfStudy);
          if (progressTimer) clearTimeout(progressTimer);

          isProcessing = false;
          clearInterval(typingInterval);

          if (!generated.logs || generated.logs.length === 0) {
            if (ctx.session.catchup) ctx.session.catchup.active = false;
            await ctx.api.deleteMessage(ctx.chat!.id, loadingMsg.message_id).catch(() => {});
            await ctx.reply(
              "I wasn't able to generate any log entries from what you shared 😔\n\nTry giving me a bit more detail about what you worked on and run /catchup again."
            );
            return;
          }

          const freshDbUser = await prisma.user.findUnique({
            where: { telegramId },
            select: { id: true },
          });
          const freshMonUser = await getMonetizationUserByTelegramId(telegramId);
          const freshIsPro = hasActiveStorage(freshMonUser!);
          const freshRemainingQuota = freshIsPro ? 9999 : Math.max(0, FREE_LOG_LIMIT - freshMonUser!.logCount);

          const logsToSave = generated.logs.slice(0, freshRemainingQuota);
          const logsToHold = generated.logs.slice(freshRemainingQuota);

          let skippedDuplicates = 0;
          if (logsToSave.length > 0) {
            const startDateParsed = parseISO(state.startDate!);
            const candidateDates = logsToSave.map(log => nthWorkingDayFrom(startDateParsed, log.dateOffset + cappedAt));

            const existingLogs = await prisma.log.findMany({
              where: {
                userId: freshDbUser!.id,
                logDate: { gte: candidateDates[0], lte: candidateDates[candidateDates.length - 1] },
              },
              select: { logDate: true },
            });
            const existingDates = new Set(existingLogs.map(l => l.logDate.toISOString().split('T')[0]));

            const insertData = logsToSave
              .map((log, i) => ({ log, logDate: candidateDates[i] }))
              .filter(({ logDate }) => !existingDates.has(logDate.toISOString().split('T')[0]))
              .map(({ log, logDate }) => ({
                userId: freshDbUser!.id,
                content: log.content,
                isAiRefined: true,
                isVoice: false,
                logDate,
              }));

            skippedDuplicates = logsToSave.length - insertData.length;

            if (insertData.length > 0) {
              await prisma.$transaction([
                prisma.log.createMany({ data: insertData }),
                prisma.user.update({
                  where: { id: freshDbUser!.id },
                  data: { logCount: { increment: insertData.length } },
                }),
              ]);
            }
          }

          await ctx.api.deleteMessage(ctx.chat!.id, loadingMsg.message_id).catch(() => {});

          if (logsToHold.length > 0) {
            if (freshDbUser) {
              await prisma.user.update({ where: { id: freshDbUser.id }, data: { hitPaywall: true } });
            }
            state.heldLogs = logsToHold.map(log => ({
              content: log.content,
              logDate: nthWorkingDayFrom(parseISO(state.startDate!), log.dateOffset + cappedAt).toISOString(),
              dateOffset: log.dateOffset + cappedAt,
            }));
            state.savedLogsCount = (state.savedLogsCount ?? 0) + logsToSave.length;
            await ctx.reply(
              `I saved *${logsToSave.length} more day${logsToSave.length === 1 ? '' : 's'}* but your free storage is now full. The remaining *${logsToHold.length}* are ready — unlock Pro to save them. 🔓` +
              (skippedDuplicates > 0 ? `\n\n_${skippedDuplicates} day${skippedDuplicates === 1 ? '' : 's'} skipped — you already had logs for those dates._` : ''),
              {
                parse_mode: "Markdown",
                reply_markup: new InlineKeyboard().text("🔓 Unlock Storage - ₦1,000", "go_pro"),
              }
            );
            await ctx.reply("For any remaining days, just run /catchup again and pick up where you left off.");
            if (ctx.session.catchup) ctx.session.catchup.active = false;
          } else {
            const totalDays = cappedAt + logsToSave.length;
            const stillCapped = generated.logs.length < remainingDays;
            await ctx.reply(
              `All *${totalDays} day${totalDays === 1 ? '' : 's'}* are now in your logbook. 🎉` +
              (skippedDuplicates > 0 ? `\n\n_${skippedDuplicates} day${skippedDuplicates === 1 ? '' : 's'} skipped — you already had logs for those dates._` : ''),
              {
                parse_mode: "Markdown",
                reply_markup: new InlineKeyboard().text("📅 View calendar", "nav_calendar").text("🏠 Menu", "nav_menu"),
              }
            );
            if (stillCapped) {
              await ctx.reply("For any remaining days, just run /catchup again and pick up where you left off.");
            }
            clearActiveFlow(ctx.session);
          }
        } catch (innerErr) {
          isProcessing = false;
          clearInterval(typingInterval);
          throw innerErr;
        }
        break;
      }
    }
  } catch (error) {
    console.error("Error in catchup flow:", error);
    if (ctx.session.catchup) ctx.session.catchup.active = false;
    await ctx.reply(
      "Something went wrong on our end 😔\n\nYour dates and notes are still saved. Type /catchup to try again — you won't have to start over."
    );
  }
}

export async function handleCatchupFlow(ctx: BotContext): Promise<void> {
  const text = ctx.message?.text?.trim();
  const state = ctx.session.catchup;
  if (!text || !state) return;
  await handleCatchupFlowWithText(ctx, text);
}