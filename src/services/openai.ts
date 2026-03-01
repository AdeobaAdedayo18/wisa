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
export async function transcribeVoice(filePath: string): Promise<string> {
  const fs = await import("fs");
  const transcription = await openai.audio.transcriptions.create({
    file: fs.createReadStream(filePath),
    model: "whisper-1",
    prompt:
      "This is a Nigerian university student describing their daily industrial training (SIWES) work activities. " +
      "Transcribe accurately, preserving their descriptions of technical tasks, tools used, and workplace experiences.",
  });
  return transcription.text;
}
