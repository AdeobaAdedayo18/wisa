import OpenAI from "openai";

export const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

/**
 * Refines a raw SIWES logbook entry into a professional, well-structured
 * write-up suitable for academic submission.
 */
export async function refineLog(rawLog: string): Promise<string> {
  const completion = await openai.chat.completions.create({
    model: "gpt-4o",
    messages: [
      {
        role: "system",
        content: `You are helping a Nigerian university student refine their SIWES (industrial training) logbook entry. 
The student did real work today your job is to make their log entry sound professional, well-structured, 
and impressive to an academic supervisor, while keeping it truthful and grounded in what they actually wrote.
Expand abbreviations, improve grammar, add professional vocabulary where appropriate, 
and structure it with a brief intro, body of activities, and a short reflective closing sentence.
Keep it between 200-400 words. Return only the refined log, no commentary.`,
      },
      { role: "user", content: rawLog },
    ],
  });
  return completion.choices[0].message.content ?? rawLog;
}

/**
 * Transcribes an OGG/voice file (local path) using OpenAI Whisper.
 * Optimised prompt for Nigerian SIWES context.
 */
const WHISPER_PROMPT =
  "This is a Nigerian university student describing their daily industrial training (SIWES) work activities. " +
  "Transcribe accurately, preserving their descriptions of technical tasks, tools used, and workplace experiences.";

// Whisper hallucination markers — returned when audio is silent/unintelligible
const HALLUCINATION_PHRASES = [
  "transcribe accurately",
  "preserving their descriptions",
  "nigerian university student",
  "siwes",
  "industrial training",
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
