import OpenAI from "openai";

export const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Refines a raw SIWES logbook entry into a professional, well-structured
 * write-up suitable for academic submission.
 */
export async function refineLog(rawLog: string): Promise<string> {
  console.log(`[refineLog] Refining log of length ${rawLog.length}`);
  const start = Date.now();
  
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o",
      messages: [
        {
          role: "system",
          content: `You are an expert technical writing assistant for a university student's industrial training (SIWES) logbook. 
Your task is to rewrite the student's raw daily activity logs into high-quality, professional, and academic entries.

Target Audience: Academic supervisors and industry mentors.
Tone: Professional, reflective, technical, and action-oriented. First-person ("I").
Style Constraints:
- Use active verbs (e.g., "Designed," "Implemented," "Researched," "Collaborated").
- Focus on *learning outcomes* and *technical details*.
- Remove informal language, fluff, and filler words.
- Do NOT use flowery intros like "Today was a productive day..." or "In conclusion...". Start directly with the activities.
- Ensure the log is concise (typically 30-75 words) but dense with value.
- Maintain the truthfulness of the original log—do not invent tasks.

See the following examples of A-grade log entries for the desired style:

Input: "learned about fintech users and problems"
Output: "I learned about the main types of fintech users and the common challenges they face, especially confusion and fear for beginners. This showed me why fintech products must be simple and guide users clearly to encourage adoption."

Input: "meeting with designers, talked about favorite feature, did research on binaries and coinbase"
Output: "I Attended team briefing to understand the objective and value of the "Favorite" feature for fintech pairs. I then Conducted market research and competitive analysis on similar features in top fintech apps (e.g., Binance, Coinbase). Identified common user expectations such as easy toggling, sorting, and visibility on the home tab."

Input: "working on spring boot, dependency injection, folder structure"
Output: "My supervisor emphasized the importance of becoming proficient in Spring Boot and Java for backend projects at Quidax. I began by setting up my development environment and explored the standard folder structure to understand how the team organizes backend projects. I delved into advanced concepts such as dependency injection, exploring constructor and setter injection to understand how the IoC container controls object lifecycles."

Input: "videos for app workflow"
Output: "I was involved in creating detailed workflow videos that demonstrate how various features of the app function. This task required me to understand the app from a user’s perspective and present its key functionalities clearly and logically. It was a collaborative effort involving scripting and screen recording to ensure new users would easily understand how to navigate the app."

Return ONLY the refined log text. Do not add conversational filler.`,
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
