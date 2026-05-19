import { InlineKeyboard } from "grammy";
import { parseISO, addDays, getDaysInMonth, startOfMonth, getDay, format } from "date-fns";
import { prisma } from "../lib/prisma";
import type { BotContext } from "./types";
import { clearActiveFlow } from "./types";
import { calculateWorkingDays } from "../utils/dateHelpers";
import { evaluateCatchupDetail, generateMultiDayLogs } from "../services/openai";
import { getMonetizationUserByTelegramId, hasActiveStorage, FREE_LOG_LIMIT } from "./monetization";

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
// START UP FLOW
// ----------------------------------------------------------------------------
export async function startCatchupFlow(ctx: BotContext) {
  clearActiveFlow(ctx.session);

  const telegramId = BigInt(ctx.from!.id);
  const dbUser = await prisma.user.findUnique({ where: { telegramId } });

  // 🚀 COURSE OF STUDY INTERCEPTOR
  if (dbUser && !dbUser.courseOfStudy) {
    // ✅ FIX #7: Initialize fresh state with all fields zeroed
    ctx.session.catchup = {
      active: true,
      step: 'awaiting_course', // Special interceptor step
      questionCount: 0,  // ✅ Always start at 0
      rawDump: undefined,
      heldLogs: undefined,
    };
    
    await ctx.reply(
      "✨ Welcome to Catch-Up Mode!\n\nBefore we generate your logs, I need to know your **Area of Study** so I can use the right technical terms\n_Please type it below:_ ✨",
      { parse_mode: "Markdown" }
    );
    return;
  }

  // If they already have a course, go straight to the calendar
  // 🚀 Added 'await' for robustness
  await triggerCatchupCalendar(ctx);
}

// Helper to launch the calendar cleanly
async function triggerCatchupCalendar(ctx: BotContext) {
  // ✅ FIX #7: Initialize fresh state with all fields
  ctx.session.catchup = {
    active: true,
    step: 'awaiting_start_date',
    questionCount: 0,  // ✅ Reset
    rawDump: undefined,
    heldLogs: undefined,
  };

  const now = new Date();
  const calendarKb = generateCatchupCalendar(now.getFullYear(), now.getMonth(), 'start');

  await ctx.reply(
    "🚀 **Catch-Up Mode Activated**\n\nLet's get your logbook up to date.\n\n👇 **Tap the START DATE of your missing logs below:**",
    { parse_mode: "Markdown", reply_markup: calendarKb }
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
        clearActiveFlow(ctx.session);
        await ctx.editMessageText("That timeframe falls entirely on a weekend! 🏖️ SIWES logs are for working days only. Try /catchup again.");
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
        clearActiveFlow(ctx.session);
        await ctx.editMessageText("Whoa, that's a lot of time! 😅 My brain can only generate up to *20 working days* at a time.\n\nPlease type /catchup and try doing it in smaller chunks!");
        await ctx.answerCallbackQuery();
        return;
      }

      state.workingDays = workingDays;
      state.step = 'awaiting_braindump';

      await ctx.editMessageText(
        `Perfect! That timeframe gives us **${workingDays} working days** (excluding weekends). \n\n` +
        `🧠 **Time for the Brain-Dump!**\n\n` +
        `Let's get those days logged! No need to write a novel—just give me a quick summary of what you've been up to. What was your main focus or project?\n\n_(Don't worry about making it perfect. Just give me the gist (you can also use a voice note), and I'll help you fill in the blanks if we need more context to cover the ${workingDays} days!)_`,
        { parse_mode: "Markdown" }
      );
    }
    await ctx.answerCallbackQuery();
  }
}

// ----------------------------------------------------------------------------
// TEXT HANDLER (Handles the Brain-dump text and Gatekeeper)
// ----------------------------------------------------------------------------
export async function handleCatchupFlow(ctx: BotContext) {
  const text = ctx.message?.text?.trim();
  const state = ctx.session.catchup;

  if (!text || !state) return;

  if (text.toLowerCase() === 'cancel' || text === '/cancel') {
    clearActiveFlow(ctx.session);
    await ctx.reply("Catch-up cancelled. Let me know when you're ready! 🏠", {
      reply_markup: new InlineKeyboard().text("🏠 Menu", "nav_menu")
    });
    return;
  }

  // ✅ ESCAPE HATCH: If user taps the "Catch up missed days" button, restart the flow seamlessly
  if (/\bCatch up|Fill missed days\b/i.test(text)) {
    return startCatchupFlow(ctx);
  }

  const telegramId = BigInt(ctx.from!.id);

  try {
    switch (state.step) {
      // 🚀 HANDLE THE COURSE OF STUDY INPUT
      case 'awaiting_course': {
        const courseText = text.trim();

        // ✅ FIX #4: Comprehensive validation
        if (courseText.length < 2) {
          await ctx.reply("Please enter a valid Course of Study!");
          return;
        }

        // ✅ Max length to prevent prompt injection
        if (courseText.length > 100) {
          await ctx.reply("Course of Study is too long. Please keep it under 100 characters.");
          return;
        }

        // ✅ Reject if it contains suspicious patterns
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
          await ctx.reply("Course names should only contain letters, numbers, and spaces. Try again!");
          return;
        }

        // ✅ Save it to the database so we never have to ask again
        await prisma.user.update({
          where: { telegramId },
          data: { courseOfStudy: courseText },
        });

        // Transition immediately to the calendar
        state.step = 'awaiting_start_date';
        state.questionCount = 0;  // ✅ Reset for next phase
        ctx.session.catchup = state;
        
        const now = new Date();
        const calendarKb = generateCatchupCalendar(now.getFullYear(), now.getMonth(), 'start');

        await ctx.reply(
          `✅ Got it! Your logs will be tailored perfectly for **${courseText}**.\n\n👇 **Now, tap the START DATE of your missing logs below:**`,
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
        state.rawDump = state.rawDump ? `${state.rawDump}\n\nUser added: ${text}` : text;
        const workingDays = state.workingDays!;
        
        // 🚀 Initialize or increment the question counter
        if (state.step === 'awaiting_braindump') {
          state.questionCount = 0;
        } else {
          state.questionCount = (state.questionCount || 0) + 1;
        }
        ctx.session.catchup = state; 

        const loadingMsg = await ctx.reply("⏳ Let me look at this data...");

        // 🚀 Start continuous "typing..." indicator
        let isProcessing = true;
        const typingInterval = setInterval(() => {
          if (isProcessing) ctx.api.sendChatAction(ctx.chat!.id, "typing").catch(() => {});
        }, 4000);

        try {
          // 🚀 THE 2-STRIKE HARD LIMIT
          let isAdequate = false;
          let questions: string[] = [];
          let maxSupportableDays = Infinity; // Default: allow all days (will be capped below)

          const dbUser = await prisma.user.findUnique({ where: { telegramId } });
          const courseOfStudy = dbUser?.courseOfStudy ?? "IT";

          // ✅ ALWAYS call evaluateCatchupDetail to get maxSupportableDays, even if 2-strike rule is hit
          const evaluation = await evaluateCatchupDetail(state.rawDump, workingDays, courseOfStudy);
          isAdequate = state.questionCount >= 2 ? true : evaluation.isAdequate; // 2-strike forces adequacy
          questions = evaluation.followUpQuestions;
          maxSupportableDays = evaluation.maxSupportableDays; // ✅ ALWAYS capture the cap

          if (!isAdequate) {
            state.step = 'interrogation';
            ctx.session.catchup = state; 
            isProcessing = false;
            clearInterval(typingInterval);
            
            const formattedQuestions = questions.map(q => `• ${q}`).join('\n');
            
            let prefix = `Good start! ✨ To make sure I can spread this smoothly across all **${workingDays} days**, just give me a quick hint on these:`;
            
            if (state.questionCount === 1) {
              prefix = `Thanks! 🙏 Just to make sure the logs don't sound repetitive, could you add a tiny bit more about:`;
            }

            await ctx.api.editMessageText(
              ctx.chat!.id,
              loadingMsg.message_id,
              `${prefix}\n\n${formattedQuestions}\n\n_(You can just drop a brief voice note or a messy text reply!)_`,
              { parse_mode: "Markdown" }
            );
            return;
          }

          // ✅ APPLY MAXSUPPORTABLEDAYS CAP: If evaluation says we can only do X days, don't generate more
          let cappedWorkingDays = workingDays;
          let daysCapped = false;
          
          if (maxSupportableDays < workingDays) {
            cappedWorkingDays = maxSupportableDays;
            daysCapped = true;
            
            // 🚀 Store for permanent warning in final message
            state.originalRequestedDays = workingDays;
            state.wasCapped = true;
            ctx.session.catchup = state;
            
            // Show warning message
            await ctx.api.editMessageText(
              ctx.chat!.id,
              loadingMsg.message_id,
              `⚠️ The details provided can only realistically cover **${cappedWorkingDays}** days without making things up. Generating **${cappedWorkingDays}** days to keep your logbook authentic!`,
              { parse_mode: "Markdown" }
            );
            
            // Brief pause to let user read the message
            await new Promise(resolve => setTimeout(resolve, 1500));
          }

          await ctx.api.editMessageText(
            ctx.chat!.id,
            loadingMsg.message_id,
            `Data looks great! ✨ Time-traveling and generating ${cappedWorkingDays} days of logs. This might take a minute...`
          );

          const generated = await generateMultiDayLogs(state.rawDump, cappedWorkingDays, courseOfStudy);

          isProcessing = false;
          clearInterval(typingInterval);

          // ✅ FIX #2: CRITICAL — Re-fetch user state JUST BEFORE slicing
          // The logCount may have changed during the 45 seconds of AI generation
          const freshDbUser = await prisma.user.findUnique({
            where: { telegramId },
            select: { id: true }
          });

          const freshMonUser = await getMonetizationUserByTelegramId(telegramId);
          const freshIsPro = hasActiveStorage(freshMonUser!);
          const freshRemainingQuota = freshIsPro ? 9999 : Math.max(0, FREE_LOG_LIMIT - freshMonUser!.logCount);

          const logsToSave = generated.logs.slice(0, freshRemainingQuota);
          const logsToHold = generated.logs.slice(freshRemainingQuota);

          // 1. Save whatever we are allowed to save to the database first
          if (logsToSave.length > 0) {
            const insertData = logsToSave.map(log => ({
              userId: freshDbUser!.id,
              content: log.content,
              isAiRefined: true,
              isVoice: false,
              logDate: addDays(parseISO(state.startDate!), log.dateOffset),
            }));

            // ✅ Atomic: Save logs AND increment counter in one transaction
            await prisma.$transaction([
              prisma.log.createMany({ data: insertData }),
              prisma.user.update({
                where: { id: freshDbUser!.id },
                data: { logCount: { increment: logsToSave.length } }
              })
            ]);
          }

          // Delete the "Let me look at this data..." loading message
          await ctx.api.deleteMessage(ctx.chat!.id, loadingMsg.message_id).catch(() => {});

          // 2. Decide which UI to show based on if they hit the paywall
          if (logsToHold.length > 0) {
            // 🚨 THEY HIT THE STORAGE LIMIT (Show 2 items max)
            state.heldLogs = logsToHold.map(log => ({
              content: log.content,
              logDate: addDays(parseISO(state.startDate!), log.dateOffset).toISOString(),
              dateOffset: log.dateOffset,
            }));
            state.savedLogsCount = logsToSave.length;  // ✅ Track how many were saved
            
            // 🚀 Include permanent capping warning if applicable
            let peekText = '';
            if (state.wasCapped && state.originalRequestedDays) {
              peekText += `⚠️ *Notice:* You requested *${state.originalRequestedDays} days*, but your prompt only had enough detail for **${cappedWorkingDays} days**. I stopped there to keep your logbook authentic and avoid making things up!\n\n`;
            }
            peekText += `✅ **Generated ${cappedWorkingDays} days successfully!** Here is a peek:\n\n`;
            const peekLogs = generated.logs.slice(0, 2);
            
            peekLogs.forEach((log, index) => {
              const logDate = addDays(parseISO(state.startDate!), log.dateOffset);
              const dateStr = logDate.toLocaleDateString('en-GB', { weekday: 'short', month: 'short', day: 'numeric' });
              peekText += `📌 **Day ${index + 1}** • _${dateStr}_\n`;
              peekText += `> ${log.content}\n\n`;
            });

            if (generated.logs.length > 2) {
              peekText += `🔒 _...and ${generated.logs.length - 2} more days._\n\n`;
            }

            await ctx.reply(peekText, { parse_mode: "Markdown" });
            
            await ctx.reply(
              `⚠️ **Storage Limit Reached!**\n\nI saved the first ${logsToSave.length} days to your logbook, but you are out of free storage. \n\nI have the remaining **${logsToHold.length} days** generated and ready. Unlock Wisa Pro for ₦1,000 to save them immediately!`,
              { 
                parse_mode: "Markdown",
                reply_markup: new InlineKeyboard().text("🔓 Unlock Storage - ₦1,000", "go_pro")
              }
            );
          } else {
            // 🎉 FULL SUCCESS (No Paywall Hit, Show 3 items max)
            
            // 🚀 Include permanent capping warning if applicable
            let successText = '';
            if (state.wasCapped && state.originalRequestedDays) {
              successText += `⚠️ **Notice:** You requested **${state.originalRequestedDays} days**, but your prompt only had enough detail for **${cappedWorkingDays} days**. I stopped there to keep your logbook authentic and avoid making things up!\n\n`;
            }
            successText += `✅ **Generated all ${cappedWorkingDays} days successfully!** Here is a quick preview:\n\n`;
            const previewLogs = generated.logs.slice(0, 3);
            
            previewLogs.forEach((log, index) => {
              const logDate = addDays(parseISO(state.startDate!), log.dateOffset);
              const dateStr = logDate.toLocaleDateString('en-GB', { weekday: 'short', month: 'short', day: 'numeric' });
              successText += `📌 **Day ${index + 1}** • _${dateStr}_\n`;
              successText += `> ${log.content}\n\n`;
            });

            if (generated.logs.length > 3) {
              successText += `✨ _...plus ${generated.logs.length - 3} more days perfectly written!_\n\n`;
            }

            await ctx.reply(successText, { parse_mode: "Markdown" });
            await ctx.reply(`🎉 All ${cappedWorkingDays} days have been safely stored in your logbook! Tap below to read them all.`, {
              reply_markup: new InlineKeyboard().text("📅 View calendar", "nav_calendar").text("🏠 Menu", "nav_menu")
            });

            // 🚀 Move clearActiveFlow to the VERY END so date reading works
            clearActiveFlow(ctx.session);
          }
        } catch (innerErr) {
          isProcessing = false;
          clearInterval(typingInterval);
          throw innerErr; // Re-throw to be caught by the outer block
        }
        break;
      }
    }
  } catch (error) {
    console.error("Error in catchup flow:", error);
    await ctx.reply("Oops, something went wrong while processing that. Please try /catchup again.", {
      reply_markup: new InlineKeyboard().text("🏠 Menu", "nav_menu")
    });
    clearActiveFlow(ctx.session);
  }
}