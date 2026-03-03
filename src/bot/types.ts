import { type Context, type SessionFlavor } from "grammy";
import { type ConversationFlavor } from "@grammyjs/conversations";

export interface SessionData {
  /** True while the bot is collecting text parts for a new log entry. */
  awaitingLog: boolean;
  /** Accumulated message chunks before the user taps Done ✅. */
  pendingLogParts: string[];
  /**
   * Unix timestamp (ms) of when the current awaiting flow was started.
   * Used for auto-expiry after 1 hour of inactivity.
   */
  flowStartedAt?: number;
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
  /** True while the bot is waiting for the user's bank account sender name for manual payment. */
  awaitingPaymentSenderName?: boolean;
  /** ManualPayment DB id waiting for admin review. */
  pendingManualPaymentId?: number;
}

export type BotContext = ConversationFlavor<Context & SessionFlavor<SessionData>>;

// ---------------------------------------------------------------------------
// Flow management helpers
// ---------------------------------------------------------------------------

const FLOW_TIMEOUT_MS = 60 * 60 * 1000; // 1 hour

/**
 * Clear ALL "awaiting" flags so no lingering flow captures text.
 * Call this before entering any new flow.
 */
export function clearActiveFlow(session: SessionData): void {
  session.awaitingLog = false;
  session.pendingLogParts = [];
  session.pendingLogDate = undefined;
  session.editingLogId = undefined;
  session.awaitingEditText = false;
  session.awaitingFeedback = false;
  session.awaitingPaymentSenderName = false;
  session.pendingVoiceTranscription = undefined;
  session.pendingRefinedContent = undefined;
  session.refiningLogId = undefined;
  session.flowStartedAt = undefined;
}

/**
 * Check if the current flow has expired (started > 1 hour ago).
 * If expired, silently clears all flags and returns true.
 */
export function isFlowExpired(session: SessionData): boolean {
  if (!session.flowStartedAt) return false;
  if (Date.now() - session.flowStartedAt > FLOW_TIMEOUT_MS) {
    clearActiveFlow(session);
    return true;
  }
  return false;
}

/** Mark that a flow is now active (resets the 1-hour timer). */
export function startFlow(session: SessionData): void {
  session.flowStartedAt = Date.now();
}
