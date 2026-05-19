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
1. ANTI-HALLUCINATION (STRICT): You must NEVER invent tasks, facts, tools, or technical concepts that are not present in the user's raw text. If the raw text is a joke, a song, a greeting, or unrelated chatter, DO NOT invent fake technical work to fill space. Just politely format exactly what they said.
2. Length: You MUST write strictly between 40 and 45 words. Count your words. Do not write fewer than 40 words, and do not exceed 45 words.
3. Structure: Break the text into 2 short paragraphs so it looks well-formatted.
4. Tone: Use simple, natural, everyday English. Sound like a real student, not a robot.
5. Banned Words: DO NOT use overly complex AI words. NEVER use words like: delve, orchestrate, seamless, foster, testament, utilize, or navigate.
6. Return ONLY the rewritten text. No introductions, no quotes, no explanations.`,
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

CRITICAL DENSITY CHECK (THE MATH OF DETAIL):
You MUST evaluate if the volume of information matches the requested days. 
- 1 to 5 days: 2-3 sentences mentioning basic tasks or tools is adequate.
- 6 to 10 days: Needs at least 1 major project, 1 minor task, and 1 specific challenge.
- 11 to 20+ days: Needs distinct project phases, major milestones, or multiple themes. 

CRITICAL RULE: READ BEFORE ASKING
CRITICAL RULE: THE LOW BAR FOR APPROVAL (TRUST THE GENERATOR)
Your job is ONLY to check if there is a basic skeleton of facts. The main AI generator will do the heavy lifting to expand this skeleton into the final daily logs. 
- Do NOT demand every single detail.
- If the user provides at least 3 distinct technical details (e.g., a tool, a task, and a bug), you MUST return { "isAdequate": true }.
- If the user writes a multi-paragraph breakdown with technical jargon (like your Prisma/Next.js example), AUTOMATICALLY return { "isAdequate": true } immediately.
- NEVER ask follow-up questions digging into things they briefly mentioned (e.g., if they mention "writing tests," do NOT ask "what kind of tests?"). Just accept it and pass them!

EVALUATION CRITERIA:
Look at the user's text. Does it contain enough distinct technical tasks, challenges, tools, or concepts to realistically spread across ${days} days without repeating information or hallucinating fake tasks?

INSTRUCTIONS (YOU MUST RETURN A JSON OBJECT):
1. If the text has enough detail (or is highly descriptive) for ${days} days, return a JSON object exactly like this:
   { "isAdequate": true, "followUpQuestions": [] }

2. ONLY if the text is genuinely too short or vague (e.g., just saying "I wrote code" for 14 days), return a JSON object exactly like this:
   { 
     "isAdequate": false, 
     "followUpQuestions": [
       "Ask ONE highly specific question related to ${courseOfStudy} about a missing detail. Do not parrot my instructions."
     ] 
   }

RULES FOR THE FOLLOW-UP QUESTION (IF NEEDED):
- Sound like a helpful senior colleague.
- Never ask them for "phases" if they already listed them.
- Ask ONLY ONE question. Keep it concise. Provide a quick example in parentheses to make it easy for them to answer.`,
        },
        { role: "user", content: rawText },
      ],
      temperature: 0.2, 
    });

    const result = JSON.parse(completion.choices[0].message.content || '{"isAdequate": false, "followUpQuestions": ["I need a bit more detail. What specific tools or projects did you focus on?"]}');
    console.log(`[evaluateCatchupDetail] Result: ${result.isAdequate} in ${Date.now() - start}ms`);
    return result as CatchupEvaluation;
  } catch (error) {
    console.error("[evaluateCatchupDetail] Error calling OpenAI:", error);
    return { isAdequate: false, followUpQuestions: ["I missed some of that. Could you break down exactly what main projects or tools you used?"] };
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
1. Task Lifecycle: Spread the work naturally across the ${days} days. For example, early days should focus on planning/setup/reading documentation, middle days on execution/troubleshooting, and final days on testing/deployment.
2. Length: EVERY SINGLE DAY MUST be strictly between 40 and 45 words. Count your words carefully. Do not write fewer than 40 words, and do not exceed 45 words. Break each day into 2 short paragraphs if possible.
3. Tone & Vocab: Use simple, natural, everyday English. Sound like a real student. NEVER use words like: delve, orchestrate, seamless, foster, testament, utilize, or navigate.

OUTPUT FORMAT:
You MUST return a valid JSON object matching this exact structure:
{
  "logs": [
    {
      "dateOffset": 0, // 0 for the first day, 1 for the second day, up to ${days - 1}
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