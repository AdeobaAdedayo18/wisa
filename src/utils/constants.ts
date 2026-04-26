import { InputFile } from "grammy";
import type { Context } from "grammy";
import path from "path";

export const SCENE_FILE_IDS: Record<string, string> = {
  scene1: "", scene2: "", scene3: "", scene4: "",
  scene5: "", scene6: "", scene7: "", scene8: "",
};

function sceneFilePath(sceneKey: string): string {
  const num = sceneKey.replace("scene", "");
  const filename = `Scene ${num}.jpg`;
  return path.resolve(process.cwd(), "src/assets", filename);
}

export async function sendScene(ctx: Context, sceneKey: string, caption: string): Promise<void> {
  const fileId = SCENE_FILE_IDS[sceneKey];
  if (fileId) {
    await ctx.replyWithPhoto(fileId, { caption, parse_mode: "Markdown" });
  } else {
    const res = await ctx.replyWithPhoto(
      new InputFile(sceneFilePath(sceneKey)),
      { caption, parse_mode: "Markdown" },
    );
    SCENE_FILE_IDS[sceneKey] = res.photo.at(-1)!.file_id;
  }
}

/**
 * Updated to support silent notifications for that afternoon strategy!
 */
export async function sendSceneViaApi(
  api: { sendPhoto: Function },
  chatId: number,
  sceneKey: string,
  caption: string,
  replyMarkup?: object,
  disableNotification: boolean = false, // Added this
): Promise<void> {
  const fileId = SCENE_FILE_IDS[sceneKey];
  const extra: Record<string, unknown> = { 
    caption, 
    parse_mode: "Markdown",
    disable_notification: disableNotification // Added this
  };
  if (replyMarkup) extra.reply_markup = replyMarkup;

  if (fileId) {
    await api.sendPhoto(chatId, fileId, extra);
  } else {
    const res = await api.sendPhoto(chatId, new InputFile(sceneFilePath(sceneKey)), extra);
    SCENE_FILE_IDS[sceneKey] = res.photo.at(-1)!.file_id;
  }
}

export const STORAGE_PLAN_AMOUNT_KOBO = 100_000;