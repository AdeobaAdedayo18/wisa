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
      messages: [
        {
          role: "system",
          content: `You are an expert academic advisor helping a university student write their daily SIWES (Industrial Training) logbook.
The student is studying: ${courseOfStudy}.
Rewrite their raw log to be professional, well-formatted, and grammatically correct.

CRITICAL CONSTRAINTS (YOU MUST OBEY THESE):
1. THE GATEKEEPER (STRICT ANTI-HALLUCINATION): If the user's input is a simple greeting (e.g., 'hey', 'hi'), a single word, gibberish, or completely lacks any description of a task, project, or activity, DO NOT generate a log. You MUST return EXACTLY this string and nothing else: "REJECTED: Please provide actual details about what you worked on."
2. Length: If the log is valid, you MUST write strictly between 40 and 45 words. Count your words. Do not write fewer than 40 words, and do not exceed 45 words.
3. Structure: Break valid logs into 2 short paragraphs so it looks well-formatted.
4. Tone: Use simple, natural, everyday English. Sound like a real student, not a robot.
5. Banned Words: DO NOT use overly complex AI words. NEVER use words like: delve, orchestrate, seamless, foster, testament, utilize, or navigate.
6. Return ONLY the rewritten text (or the REJECTED string). No introductions, no quotes, no explanations.`,
        },
        { role: "user", content: rawLog },
      ],
      temperature: 0.3,
    });
    
    const refined = completion.choices[0].message.content ?? rawLog;
    console.log(`[refineLog] Success! Refined length: ${refined.length}. Duration: ${Date.now() - start}ms`);
    return refined;
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
// 🚀 FIXED: Kept your new instructions but restored the courseOfStudy parameter so it doesn't crash!
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
          content: `You are an expert academic evaluator checking a university student's raw brain-dump for their SIWES (Industrial Training) logbook.
The student is studying: ${courseOfStudy}.
The student needs to generate logs for exactly ${days} working days.

⚠️ **RUTHLESS HALLUCINATION PREVENTION** ⚠️
Your PRIMARY job is to calculate maxSupportableDays WITHOUT HALLUCINATION.
Do NOT grant 8 days to someone with 3 sentences of context. Be EXTREMELY conservative.

DENSITY MAPPING (THE STRICTEST RULE):
- 1 short sentence (e.g., "I did fieldwork" or "I attended meetings") = MAX 1 day realistically
- 2-3 sentences mentioning 1-2 distinct work areas = MAX 2 days
- 1 paragraph with 3 distinct activities/areas = MAX 3 days
- 2 paragraphs with 4+ distinct activities/challenges = MAX 5 days
- Multi-paragraph with detailed phases and multiple work areas = MAX 10+ days

CRITICAL: Count the DISTINCT work activities/areas mentioned:
- "I monitored, analyzed, and reported" = 3 activities = can support ~3-4 days max
- "I worked on Area A and Area B with different methods" = 2 major work areas = can support ~4-6 days max
- Just repeating the same activity over and over = DO NOT allow many days, cap severely

INSTRUCTIONS (YOU MUST RETURN A JSON OBJECT):
Analyze the text FIRST. Count the distinct work activities, areas, or responsibilities mentioned.
THEN calculate maxSupportableDays RUTHLESSLY.

Return JSON with BOTH checks:
1. isAdequate: true if ${days} days is realistic given the detail. false if the data is too thin.
2. maxSupportableDays: The MAXIMUM days you can realistically generate WITHOUT HALLUCINATION (even if user asked for more).
   - NEVER return more than 3x the distinct work activities found.
   - If user provided 1 sentence, maxSupportableDays is AT MOST 1.
   - If user provided 3 sentences, maxSupportableDays is AT MOST 2-3.
   - Be conservative and protect the student from fake logs!

Example JSON (isAdequate=true case):
{
  "isAdequate": true,
  "maxSupportableDays": 4,
  "followUpQuestions": []
}

Example JSON (isAdequate=false case):
{
  "isAdequate": false,
  "maxSupportableDays": 2,
  "followUpQuestions": ["Can you tell me more about the specific areas or tasks you focused on?"]
}`,
        },
        { role: "user", content: rawText },
      ],
      temperature: 0.2, 
    });

    const result = JSON.parse(completion.choices[0].message.content || '{"isAdequate": false, "maxSupportableDays": 1, "followUpQuestions": ["Can you tell me more about the specific areas or tasks you worked on?"]}');
    console.log(`[evaluateCatchupDetail] Result: isAdequate=${result.isAdequate}, maxSupportableDays=${result.maxSupportableDays} in ${Date.now() - start}ms`);
    
    // ✅ SAFETY: Ensure maxSupportableDays is always set
    if (!result.maxSupportableDays || result.maxSupportableDays < 1) {
      result.maxSupportableDays = 1;
    }
    
    return result as CatchupEvaluation;
  } catch (error) {
    console.error("[evaluateCatchupDetail] Error calling OpenAI:", error);
    return { isAdequate: false, maxSupportableDays: 1, followUpQuestions: ["I missed some of that. Could you tell me more about what areas you worked on?"] };
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
          content: `You are an expert academic advisor writing a multi-day SIWES (Industrial Training) logbook for a student studying: ${courseOfStudy}.
The student has provided a brain-dump of their work. You must expand this into exactly ${days} daily log entries.

CRITICAL CONSTRAINTS (YOU MUST OBEY THESE):
1. Work Progression: Spread the work naturally across the ${days} days. Think of it as early days = planning/observation/setup, middle days = main work/learning, final days = review/documentation/wrap-up. Match the actual progression described, not forced phases.
2. Length: EVERY SINGLE DAY MUST be strictly between 40 and 45 words. Count your words carefully. Do not write fewer than 40 words, and do not exceed 45 words. Break each day into 2 short paragraphs if possible.
3. Tone & Vocab: Use simple, natural, everyday English. Sound like a real student. NEVER use words like: delve, orchestrate, seamless, foster, testament, utilize, navigate, leverage, or synergize. Use domain-appropriate terminology for ${courseOfStudy}.
4. Authenticity: Match the work described. If about fieldwork, mention fields/samples. If about meetings, mention discussions/presentations. Never hallucinate tools or activities not implied.

OUTPUT FORMAT:
You MUST return a valid JSON object matching this exact structure:
{
  "logs": [
    {
      "dateOffset": 0,
      "content": "The log for this day..."
    }
  ]
}`,
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