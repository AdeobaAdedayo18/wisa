import OpenAI from "openai";

export const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Refines a raw SIWES logbook entry into a professional, well-structured
 * write-up suitable for academic submission.
 */
export async function refineLog(rawLog: string, courseOfStudy: string = "IT"): Promise<string> {
  console.log(`[refineLog] Refining log of length ${rawLog.length}`);
  const start = Date.now();
  
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      response_format: { type: "json_object" }, 
      messages: [
        {
          role: "system",
          content: `You are an expert academic advisor helping a university student write their daily SIWES (Industrial Training) logbook. The student is studying: ${courseOfStudy}.

STEP 1: EVALUATION (THE STRICT LENIENCY RULE)
Check if the user's input is a valid log attempt. YOU MUST BE EXTREMELY LENIENT.
- ACCEPT (isValid: true): If there is ANY attempt to describe an activity, a place, an observation, or a task, you MUST accept it. Even if it is very short (e.g., "went to site", "fixed computer"), heavily misspelled due to voice-to-text, or has terrible grammar, you must accept it and attempt to make professional sense of it.
- REJECT (isValid: false): ONLY reject if the input is PURELY a simple greeting ("hey", "hello", "hi"), completely empty, or literal keyboard smash gibberish ("hjhj", "asdfgh"). If there is even a tiny hint of work or learning, do NOT reject.

STEP 2: REFINEMENT (ONLY IF VALID)
If isValid is true, rewrite their raw log to be professional, coherent, and grammatically correct based on what they likely meant. Expand on it intelligently based on their ${courseOfStudy}.
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

export interface CatchupEvaluation {
  isAdequate: boolean;
  followUpQuestions: string[];
  maxSupportableDays: number; // ✅ CRITICAL: Cap on realistically generatable days (prevents hallucination)
}

export interface GeneratedCatchup {
  logs: Array<{
    dateOffset: number; // 0 for start date, 1 for the next working day, etc.
    content: string;
  }>;
}

/**
 * The Gatekeeper: Evaluates if the user's brain-dump has enough meat to stretch 
 * across the requested number of working days.
 */
export async function evaluateCatchupDetail(rawText: string, days: number, courseOfStudy: string = "IT"): Promise<CatchupEvaluation> {
  console.log(`[evaluateCatchupDetail] Checking adequacy of "${rawText.substring(0, 30)}..." for ${days} days...`);
  const start = Date.now();

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You are evaluating a SIWES (Industrial Training) logbook brain-dump for a Nigerian university student studying ${courseOfStudy}.

They want logs for ${days} working days.

TWO JOBS:
1. Is there enough identifiable work content to generate any logs at all? (isAdequate)
2. How many days can be realistically written from this input without fabricating details? (maxSupportableDays)

STRICT NO-INVENTION RULE: The downstream generator will ONLY expand what the student mentioned. It will NOT invent meetings, orientations, briefings, site walkthroughs, reading manuals, or any other activity the student did not state. When estimating maxSupportableDays, count ONLY days that can be filled by expanding the student's stated activities into stages (diagnosis, active work, testing, documentation). Do NOT count days that would require inventing tasks the student never mentioned.

━━━━━━━━━━━━━━━━━━━━━
isAdequate = false (maxSupportableDays = 0)
━━━━━━━━━━━━━━━━━━━━━
• Pure gibberish or keyboard smash
• Empty text or whitespace only
• Lone greeting with no work context ("hi", "hello")
• Fewer than 3 meaningful words with no identifiable work activity (e.g. "I was there", "nothing much", "just stuff")

When isAdequate=false: provide 1–2 targeted follow-up questions addressing the specific gap. Make them concrete and specific. Do NOT ask generic questions like "Can you tell me more?"

Good examples:
- "What kind of network tasks were you doing — hardware setup, software configuration, cabling, or fault diagnosis?"
- "What data were you entering and which system — a spreadsheet, accounting software, or a custom database?"

━━━━━━━━━━━━━━━━━━━━━
isAdequate = true (estimate maxSupportableDays honestly)
━━━━━━━━━━━━━━━━━━━━━
Count only days coverable by expanding the student's stated activities — not days that would need invented content:
• 1 vague activity with no detail (e.g. "did data entry", "helped with network"): 1 task × ~4–6 expansion stages = maxSupportableDays = min(6, ${days})
• 2–3 activities with some context: each task gets 3–4 stages = maxSupportableDays = min(12, ${days})
• 4+ distinct activities OR detailed descriptions: maxSupportableDays = min(18, ${days})
• Rich multi-sentence notes covering multiple tasks with clear context: maxSupportableDays = ${days}

When isAdequate=true: followUpQuestions must be an empty array [].

Return ONLY valid JSON:
{
  "isAdequate": boolean,
  "maxSupportableDays": number,
  "followUpQuestions": string[]
}`,
        },
        { role: "user", content: rawText },
      ],
      temperature: 0.2, 
    });

    const result = JSON.parse(completion.choices[0].message.content || '{"isAdequate": false, "maxSupportableDays": 0, "followUpQuestions": ["Can you tell me more about the specific areas or tasks you worked on?"]}');
    console.log(`[evaluateCatchupDetail] Result: isAdequate=${result.isAdequate}, maxSupportableDays=${result.maxSupportableDays} in ${Date.now() - start}ms`);
    
    // ✅ SAFETY: Allow 0 for gibberish, but prevent undefined or negatives
    if (typeof result.maxSupportableDays !== 'number' || result.maxSupportableDays < 0) {
      result.maxSupportableDays = 0;
    }
    
    return result as CatchupEvaluation;
  } catch (error) {
    console.error("[evaluateCatchupDetail] Error calling OpenAI:", error);
    return { isAdequate: false, maxSupportableDays: 0, followUpQuestions: ["I missed some of that. Could you tell me more about what areas you worked on?"] };
  }
}

/**
 * The Generator: Uses a Task Lifecycle to stretch the brain-dump into distinct,
 * high-quality daily logs.
 */
export async function generateMultiDayLogs(rawText: string, days: number, courseOfStudy: string = "IT"): Promise<GeneratedCatchup> {
  console.log(`[generateMultiDayLogs] Generating ${days} logs...`);
  const start = Date.now();

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o", // Smart model for high-quality generation
      response_format: { type: "json_object" },
      messages: [
        {
          role: "system",
          content: `You are a professional SIWES (Industrial Training) logbook writer for a Nigerian university student studying: ${courseOfStudy}.

Your task: Generate daily log entries from the student's brain-dump.

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

4. FIELD-APPROPRIATE: Use technical terminology realistic for ${courseOfStudy}. A civil engineering student writes about sites, concrete, and measurements — not code reviews. A computer science student writes about algorithms, testing, and deployments — not structural surveys.

5. NEVER WARN: Do NOT include any notices, disclaimers, or apologies. Write every log as if it is a real, lived experience.

════════════════════════════════════════
   OUTPUT FORMAT (STRICTLY JSON)
════════════════════════════════════════

Return ONLY a valid JSON object with exactly this structure — no extra text, no markdown fences:
{
  "logs": [
    { "dateOffset": 0, "content": "Exactly 40-45 words for day 1..." },
    { "dateOffset": 1, "content": "Exactly 40-45 words for day 2..." },
    ...continue until dateOffset ${days - 1}
  ]
}

Aim for exactly ${days} objects. Return fewer only if you cannot fill the remaining days without inventing content not present in the brain-dump.`,
        },
        { role: "user", content: rawText },
      ],
      temperature: 0.4,
    });

    const result = JSON.parse(completion.choices[0].message.content || '{"logs": []}');
    console.log(`[generateMultiDayLogs] Success in ${Date.now() - start}ms`);
    return result as GeneratedCatchup;
  } catch (error) {
    console.error("[generateMultiDayLogs] Error calling OpenAI:", error);
    throw error;
  }
}