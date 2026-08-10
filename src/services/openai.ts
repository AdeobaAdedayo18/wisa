import OpenAI from "openai";
import { CatchupTier } from "../prisma/enums";

// The SDK defaults are a 10 minute timeout and 2 retries, so a single hung
// request could keep a paying user staring at a loading message for half an
// hour. 90s x 2 attempts caps the worst case at three minutes.
export const openai = new OpenAI({
  apiKey: process.env.OPENAI_API_KEY,
  timeout: 90_000,
  maxRetries: 1,
});

/**
 * Refines a raw SIWES logbook entry into a professional, well-structured
 * write-up suitable for academic submission.
 */
export async function refineLog(rawLog: string, workplaceRole: string = "IT"): Promise<string> {
  console.log(`[refineLog] Refining log of length ${rawLog.length}`);
  const start = Date.now();
  
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      response_format: { type: "json_object" }, 
      messages: [
        {
          role: "system",
          content: `You are helping a Nigerian student on an industrial placement write their daily SIWES (Industrial Training) logbook. The user works as: ${workplaceRole}.

STEP 1: EVALUATION (THE STRICT LENIENCY RULE)
Check if the user's input is a valid log attempt. YOU MUST BE EXTREMELY LENIENT.
- ACCEPT (isValid: true): If there is ANY attempt to describe an activity, a place, an observation, or a task, you MUST accept it. Even if it is very short (e.g., "went to site", "fixed computer"), heavily misspelled due to voice-to-text, or has terrible grammar, you must accept it and attempt to make professional sense of it.
- REJECT (isValid: false): ONLY reject if the input is PURELY a simple greeting ("hey", "hello", "hi"), completely empty, or literal keyboard smash gibberish ("hjhj", "asdfgh"). If there is even a tiny hint of work or learning, do NOT reject.

STEP 2: REFINEMENT (ONLY IF VALID)
If isValid is true, rewrite their raw log to be professional, coherent, and grammatically correct based on what they likely meant. Expand on it intelligently using the practical, day-to-day responsibilities of someone working as "${workplaceRole}", not generic academic concepts.
- Length: You MUST write strictly between 40 and 45 words. Count your words.
- Structure: Break into 2 short paragraphs.
- Tone: Simple, natural English.
- Banned Words: DO NOT use overly complex AI words (e.g., delve, orchestrate, seamless, foster, testament, utilize, navigate).

OUTPUT FORMAT (JSON ONLY):
You MUST return a JSON object with exactly these two keys:
{
  "isValid": boolean,
  "refinedText": "The 40-45 word rewritten log here. Leave empty if isValid is false."
}`
        },
        { role: "user", content: rawLog },
      ],
      temperature: 0.3,
    });
    
    // Parse the JSON response
    const result = JSON.parse(completion.choices[0].message.content || '{"isValid": false, "refinedText": ""}');
    
    // If the AI flagged it as pure gibberish/greeting, return our exact interceptor string
    if (!result.isValid) {
      console.log(`[refineLog] ❌ AI rejected input: "${rawLog}"`);
      return "REJECTED: Please provide actual details about what you worked on.";
    }

    console.log(`[refineLog] ✅ Success! Refined length: ${result.refinedText.length}. Duration: ${Date.now() - start}ms`);
    return result.refinedText;
    
  } catch (error) {
    console.error("[refineLog] Error calling OpenAI:", error);
    throw error; // Let the caller handle the UI for errors
  }
}

/**
 * Transcribes an OGG/voice file (local path) using OpenAI Whisper.
 * Optimised prompt for Nigerian SIWES context.
 */
const WHISPER_PROMPT =
  "This is a Nigerian university student describing their daily industrial training (SIWES) work activities. " +
  "Transcribe accurately, preserving their descriptions of technical tasks, tools used, and workplace experiences.";

// Whisper hallucination markers — only flag if transcription looks like it's echoing the prompt itself
// Check for multi-word phrases that are unlikely to appear naturally in user speech
const HALLUCINATION_PHRASES = [
  "transcribe accurately",
  "preserving their descriptions",
  "nigerian university student describing their daily industrial training",
];

export async function transcribeVoice(filePath: string): Promise<string | null> {
  const fs = await import("fs");
  
  // Log file info before transcription
  const fileStats = fs.statSync(filePath);
  console.log(`[transcribeVoice] Starting transcription for file: ${filePath}`);
  console.log(`[transcribeVoice] File size: ${fileStats.size} bytes (${(fileStats.size / 1024 / 1024).toFixed(2)} MB)`);
  
  const transcription = await openai.audio.transcriptions.create({
    file: fs.createReadStream(filePath),
    model: "whisper-1",
    prompt: WHISPER_PROMPT,
  });

  const text = transcription.text.trim();
  console.log(`[transcribeVoice] Raw Whisper response length: ${text.length} chars`);
  console.log(`[transcribeVoice] Raw Whisper response: "${text.substring(0, 200)}${text.length > 200 ? '...' : ''}"}`);

  // Detect empty result or Whisper echoing back the prompt (silent/unclear audio)
  if (!text) {
    console.log(`[transcribeVoice] ❌ Transcription failed: empty result`);
    return null;
  }
  
  const lower = text.toLowerCase();
  const matchedPhrase = HALLUCINATION_PHRASES.find((p) => lower.includes(p));
  if (matchedPhrase) {
    console.log(`[transcribeVoice] ❌ Hallucination detected: found phrase "${matchedPhrase}" in transcription`);
    console.log(`[transcribeVoice] Full text that triggered hallucination check: "${text}"}`);
    return null;
  }

  console.log(`[transcribeVoice] ✅ Transcription successful: ${text.length} chars`);
  return text;
}

// ============================================================================
// CATCH-UP ENGINE: AI PROMPTS
// ============================================================================

export interface CatchupDumpEvaluation {
  sufficientForCurrentChunk: boolean;
  followUpQuestions: string[];
}

export interface CatchupEvaluation {
  isAdequate: boolean;
  followUpQuestions: string[];
  maxSupportableDays: number;
}

export interface GeneratedCatchup {
  logs: Array<{
    /**
     * The raw logbook entry, and nothing else — no headings, labels, or bullets.
     * This string is written straight to `Log.content` for the student to copy
     * into their physical logbook, so anything decorative here ends up there.
     */
    content: string;
  }>;
}

/**
 * The Gatekeeper: Evaluates whether the current block has enough technical detail
 * to be safely expanded without hallucinating or repeating itself.
 *
 * `workplaceRole` is the user's job role and department at their placement
 * (e.g. "network support intern, IT department"), NOT an academic course.
 */
export async function evaluateCatchupDump(
  rawText: string,
  tier: CatchupTier,
  totalDuration: number,
  workplaceRole: string = "IT",
): Promise<CatchupDumpEvaluation> {
  console.log(`[evaluateCatchupDump] Checking dump of "${rawText.substring(0, 30)}..." for tier=${tier}, totalDuration=${totalDuration}`);
  const start = Date.now();

  const tierLabel = {
    QUICK_FIX: "a few weeks",
    FULL_BACKLOG: "a multi-month backlog",
    VIP_DEFENSE: "a VIP final-report backlog",
  }[tier];

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You are evaluating a SIWES (Industrial Training) logbook brain-dump for a Nigerian student on an industrial placement working as: ${workplaceRole}.

The current catch-up chunk is for tier ${tier} (${tierLabel}) and the user selected a totalDuration of ${totalDuration}.

Your job is to decide whether the provided text has enough specific technical depth to support the current chunk without hallucinating, inventing details, or repeating itself.

STRICT SOURCE RULE:
Only use the user's stated projects, tools, tasks, bugs, issues, and lessons. Do not invent meetings, orientations, briefings, tours, or any other activities not mentioned by the user.

SAY YES only when the text contains enough concrete technical substance to write a believable block for this current chunk.
SAY NO when the dump is too vague, too thin, or would force the model to pad with invented detail.

If the answer is NO, return 1–2 targeted follow-up questions that ask for the missing technical specifics needed for this current chunk. Questions must be concrete and grounded in the student's work context.

WORKPLACE ROLE RULE (STRICT):
The user's specific role and department at their workplace is: ${workplaceRole}. You MUST ensure that every generated daily task strictly aligns with the practical, day-to-day responsibilities of this specific job role, rather than generic academic concepts.

When asking follow-up questions, strictly tailor them to that role and the work it actually involves (e.g., a lab analyst, an accounts clerk, a site engineer). DO NOT default to asking about "programming languages" or "software tools" unless the role is explicitly an IT/software one.

Return ONLY valid JSON:
{
  "sufficientForCurrentChunk": boolean,
  "followUpQuestions": string[]
}`,
        },
        { role: "user", content: rawText },
      ],
      temperature: 0.2, 
    });

    const result = JSON.parse(completion.choices[0].message.content || '{"sufficientForCurrentChunk": false, "followUpQuestions": ["Can you tell me more about the specific tools, tasks, or challenges you handled?"]}');
    console.log(`[evaluateCatchupDump] Result: sufficientForCurrentChunk=${result.sufficientForCurrentChunk} in ${Date.now() - start}ms`);

    return {
      sufficientForCurrentChunk: Boolean(result.sufficientForCurrentChunk),
      followUpQuestions: Array.isArray(result.followUpQuestions) ? result.followUpQuestions.filter((item: unknown) => typeof item === 'string') : [],
    };
  } catch (error) {
    console.error("[evaluateCatchupDump] Error calling OpenAI:", error);
    return { sufficientForCurrentChunk: false, followUpQuestions: ["I missed some of that. Could you tell me more about the tools, tasks, or challenges you handled?"] };
  }
}

export async function evaluateCatchupDetail(rawText: string, days: number, workplaceRole: string = "IT"): Promise<CatchupEvaluation> {
  const result = await evaluateCatchupDump(rawText, CatchupTier.QUICK_FIX, days, workplaceRole);
  return {
    isAdequate: result.sufficientForCurrentChunk,
    followUpQuestions: result.followUpQuestions,
    maxSupportableDays: result.sufficientForCurrentChunk ? days : 0,
  };
}

/**
 * Belt-and-braces for the raw-entry rule: strips a leading `Task:` /
 * `Summary:` / `Learnings:` style label if the model prepends one anyway.
 *
 * Deliberately narrow — it only fires on a known label at the very start of the
 * string, so ordinary prose that happens to contain a colon is left untouched.
 */
function stripEntryLabels(content: string): string {
  return content
    .replace(/^\s*(?:daily\s+)?(?:log\s+entry|entry|task|activity|work\s+done|weekly\s+summary|summary|learnings?|lessons?\s+learn(?:ed|t))\s*:\s*/i, "")
    .trim();
}

/**
 * The Generator: Uses a Task Lifecycle to stretch the brain-dump into distinct,
 * high-quality daily logs.
 *
 * `workplaceRole` is the user's job role and department. See `evaluateCatchupDump`.
 */
export async function generateCatchupLogs(
  rawText: string,
  days: number,
  workplaceRole: string = "IT",
  maxDays: number = days,
  /** Lets the caller kill an in-flight generation when the user cancels. */
  signal?: AbortSignal,
): Promise<GeneratedCatchup> {
  console.log(`[generateCatchupLogs] Generating up to ${maxDays} logs for ${days} requested days...`);
  const start = Date.now();

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o", // Smart model for high-quality generation
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You are a professional SIWES (Industrial Training) logbook writer for a Nigerian student on an industrial placement.

The user's specific role and department at their workplace is: ${workplaceRole}. You MUST ensure that every generated daily task strictly aligns with the practical, day-to-day responsibilities of this specific job role, rather than generic academic concepts.

Your task: Generate daily log entries from the student's brain-dump.
The requested block duration is ${days} days, but you must generate at most ${maxDays} entries.

════════════════════════════════════════
   THE STRICT SOURCE RULE — THIS OVERRIDES EVERYTHING ELSE
════════════════════════════════════════

You may ONLY write about activities the student explicitly mentioned in their brain-dump.

NEVER INVENT THE FOLLOWING — even if they sound realistic:
  ✗ Orientation sessions, team introductions, or site familiarisation
  ✗ Morning briefings, team meetings, or department meetings
  ✗ Site walkthroughs or department tours
  ✗ Reading manuals, standards, or technical documents
  ✗ Supervisor check-ins or feedback sessions
  ✗ Any other activity not stated or clearly implied by the student

If the student said "network maintenance and data entry" — every single log entry must trace directly back to network maintenance or data entry. Nothing else exists.

════════════════════════════════════════
   THE EXPANSION TECHNIQUE (YOUR ONLY STRETCHING METHOD)
════════════════════════════════════════

Expanding means taking one real task the student mentioned and describing different stages of it across multiple days. The underlying activity stays the same — only the daily focus shifts.

Example — student said "network maintenance":
  Day 1: Inspecting network segments to identify connectivity faults and logging affected nodes
  Day 2: Replacing damaged cables and reconfiguring switches on the affected segments
  Day 3: Running diagnostics and testing restored connections across the network
  Day 4: Compiling a fault report documenting findings, repairs carried out, and current status

All four days came from ONE mentioned task. Nothing was invented.

MULTIPLE TASKS:
  • 2 tasks → alternate between them day by day, expanding each through its stages
  • 3+ tasks → cycle through them, expanding each
  • NEVER introduce a task the student did not mention to fill remaining days

STRUCTURE REQUIRED FOR EACH ENTRY:
Return each log as a JSON object with exactly this one key:
{
  "content": "the raw log entry text for that day"
}

Order matters: the first object is the first working day, the second is the
next working day, and so on. Do NOT number the days or include any date field.

Do not exceed ${maxDays} entries.

════════════════════════════════════════
   WHEN YOU CANNOT FILL ALL ${days} DAYS
════════════════════════════════════════

If honestly expanding the student's stated activities cannot fill ${days} days without fabricating new content — return fewer log entries. Return only the days you can write truthfully. Do NOT pad with invented activities.

The evaluation step already capped the count to match this input. Trust that cap.

════════════════════════════════════════
   MANDATORY CONSTRAINTS
════════════════════════════════════════

1. WORD COUNT: Every single log entry MUST be between 40 and 45 words. Count words for every entry. No entry may be shorter than 40 words or longer than 45 words. Break each into 2 short paragraphs where natural.

2. NO REPETITION: Each day must feel distinct. Never copy sentences verbatim between days. Vary the specific stage, vocabulary, and detail — even when covering the same task.

3. NATURAL LANGUAGE: Write like a real university student producing a professional log. Use simple, clear sentences. BANNED WORDS (never use): delve, orchestrate, seamless, foster, testament, utilize, navigate, leverage, synergize, spearhead, embark.

4. ROLE-APPROPRIATE: Use the technical terminology and tools someone actually working as "${workplaceRole}" would handle day to day. Write the tasks that role performs on the job — not what a student studying the subject would learn in a lecture. A site supervisor writes about pours, setting-out, and site measurements; an accounts intern writes about postings, reconciliations, and vouchers; a network support intern writes about switches, tickets, and connectivity faults.

5. NEVER WARN: Do NOT include any notices, disclaimers, or apologies. Write every log as if it is a real, lived experience.

6. RAW ENTRY ONLY: For each day, output ONLY the raw narrative log entry. Do not include headings, labels (e.g., 'Task:', 'Summary:', 'Learnings:'), bullet points, or any extra metadata. Provide only the exact continuous text the student will copy-paste directly into their physical logbook.
   The "content" value must begin with the first word of the entry itself — never with a label, a day number, a date, or a title.

════════════════════════════════════════
   OUTPUT FORMAT (STRICTLY JSON)
════════════════════════════════════════

Return ONLY a valid JSON object with exactly this structure — no extra text, no markdown fences.
Each entry is one raw string, in day order. No other keys are permitted:
{
  "logs": [
    { "content": "..." },
    { "content": "..." },
    ...one object per working day, in order, up to ${days} of them
  ]
}

Aim for exactly ${maxDays} objects. Return fewer only if you cannot fill the remaining days without inventing content not present in the brain-dump.`,
        },
        { role: "user", content: rawText },
      ],
      temperature: 0.4,
    }, { signal });

    const parsed = JSON.parse(completion.choices[0].message.content || '{"logs": []}');
    const rawEntries = Array.isArray(parsed.logs)
      ? parsed.logs
          .filter((entry: unknown) => entry && typeof entry === "object")
          .map((entry: any) => ({
            content: stripEntryLabels(typeof entry.content === "string" ? entry.content : ""),
          }))
      : [];

    // An entry with no usable content used to be backfilled with
    // `Task: …\nWeekly Summary: …` — the exact labelled format this prompt now
    // forbids, written straight into the student's logbook. There is nothing
    // honest to substitute, so drop the entry instead of decorating it.
    const logs = rawEntries.filter((entry: { content: string }) => entry.content.length > 0).slice(0, maxDays);

    if (logs.length < rawEntries.length) {
      console.warn(`[generateCatchupLogs] Dropped ${rawEntries.length - logs.length} entr(ies) with empty content`);
    }

    console.log(`[generateCatchupLogs] Success in ${Date.now() - start}ms`);
    return { logs } as GeneratedCatchup;
  } catch (error) {
    console.error("[generateCatchupLogs] Error calling OpenAI:", error);
    throw error;
  }
}

export async function generateMultiDayLogs(rawText: string, days: number, workplaceRole: string = "IT"): Promise<GeneratedCatchup> {
  return generateCatchupLogs(rawText, days, workplaceRole, days);
}