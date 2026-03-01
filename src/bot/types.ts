import { type Context, type SessionFlavor } from "grammy";
import { type ConversationFlavor } from "@grammyjs/conversations";

export interface SessionData {
  /** True while the bot is collecting text parts for a new log entry. */
  awaitingLog: boolean;
  /** Accumulated message chunks before the user taps Done ✅. */
  pendingLogParts: string[];
  /**
   * ISO date string (YYYY-MM-DD) for the log being written.
   * Defaults to today when undefined.
   */
  pendingLogDate?: string;
  /** ID of the Log record currently being edited. */
  editingLogId?: number;
  /** True while the bot is waiting for replacement text for an edit. */
  awaitingEditText?: boolean;
  /** Calendar year shown in the past-log date picker. */
  pastCalYear?: number;
  /** Calendar month (0–11) shown in the past-log date picker. */
  pastCalMonth?: number;
  /** Calendar year shown in the log-view calendar (📅 Calendar button). */
  viewCalYear?: number;
  /** Calendar month (0–11) shown in the log-view calendar. */
  viewCalMonth?: number;
  /**
   * Temporarily holds the refined content returned by OpenAI while the user
   * decides whether to accept it (keyed by log ID).
   */
  pendingRefinedContent?: string;
  /** Log ID currently being refined — used to correlate the accept callback. */
  refiningLogId?: number;
  /**
   * Transcription text from Whisper while the user decides whether to save
   * it as a log entry.
   */
  pendingVoiceTranscription?: string;
  /** True while the bot is waiting for a feedback message from the user. */
  awaitingFeedback?: boolean;
  /** Paystack payment reference generated for the current payment attempt. */
  pendingPaystackRef?: string;
}

export type BotContext = ConversationFlavor<Context & SessionFlavor<SessionData>>;
