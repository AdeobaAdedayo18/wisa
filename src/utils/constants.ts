import { InputFile } from "grammy";
import type { Context } from "grammy";
import path from "path";

// ---------------------------------------------------------------------------
// Scene file_id cache
// On the first send, Telegram returns a file_id we persist here so subsequent
// sends are instant (no re-upload required).
// ---------------------------------------------------------------------------

export const SCENE_FILE_IDS: Record<string, string> = {
  scene1: "",
  scene2: "",
  scene3: "",
  scene4: "",
  scene5: "",
  scene6: "",
  scene7: "",
  scene8: "",
};

/**
 * Resolve the on-disk path for a scene image.
 * Files live at src/assets/Scene N.jpg (e.g. "Scene 1.jpg").
 * sceneKey format: "scene1" … "scene8".
 * Uses process.cwd() so it works correctly from both `tsx watch` and `node dist/`.
 */
function sceneFilePath(sceneKey: string): string {
  const num = sceneKey.replace("scene", "");
  const filename = `Scene ${num}.jpg`;
  return path.resolve(process.cwd(), "src/assets", filename);
}

/**
 * Send a Ghibli scene image with a caption.
 * Uses the cached file_id for speed; uploads from disk on first send.
 */
export async function sendScene(ctx: Context, sceneKey: string, caption: string): Promise<void> {
  const fileId = SCENE_FILE_IDS[sceneKey];
  if (fileId) {
    await ctx.replyWithPhoto(fileId, { caption, parse_mode: "Markdown" });
  } else {
    const res = await ctx.replyWithPhoto(
      new InputFile(sceneFilePath(sceneKey)),
      { caption, parse_mode: "Markdown" },
    );
    // Cache the file_id returned by Telegram for all future sends
    SCENE_FILE_IDS[sceneKey] = res.photo.at(-1)!.file_id;
  }
}

/**
 * Send a Ghibli scene image directly via bot.api (no Context available).
 * Used by the scheduler where we only have a chat_id, not a ctx.
 */
export async function sendSceneViaApi(
  api: { sendPhoto: Function },
  chatId: number,
  sceneKey: string,
  caption: string,
  replyMarkup?: object,
): Promise<void> {
  const fileId = SCENE_FILE_IDS[sceneKey];
  const extra: Record<string, unknown> = { caption, parse_mode: "Markdown" };
  if (replyMarkup) extra.reply_markup = replyMarkup;

  if (fileId) {
    await api.sendPhoto(chatId, fileId, extra);
  } else {
    const res = await api.sendPhoto(chatId, new InputFile(sceneFilePath(sceneKey)), extra);
    SCENE_FILE_IDS[sceneKey] = res.photo.at(-1)!.file_id;
  }
}

// ---------------------------------------------------------------------------
// Pro plan price (in kobo — ₦5,000)
// ---------------------------------------------------------------------------
export const PRO_PLAN_AMOUNT_KOBO = 500_000;
