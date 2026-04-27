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
  /** True while the bot is waiting for payment email capture. */
  awaitingPaymentEmail?: boolean;
  /** Last email entered for payment flow before Paystack initialization. */
  pendingPaymentEmail?: string;
  /** True while the bot is waiting for the user's bank account sender name for manual payment. */
  awaitingPaymentSenderName?: boolean;
  /** ManualPayment DB id waiting for admin review. */
  pendingManualPaymentId?: number;
  /**
   * Unix timestamp (ms) of the last log message the user sent during
   * the current awaitingLog flow. Used by the auto-save cron to detect idle.
   */
  lastLogMessageAt?: number;
  /** True once the "Save what you have?" auto-save prompt has been sent. */
  autoSavePromptSent?: boolean;

  /**
   * When a user hits the storage wall mid-action, we set this so that after
   * Paystack success (webhook) we can prompt them to resume what they were doing.
   * Stored in Prisma-backed session value (no schema changes required).
   */
  postPaymentAction?:
    | { type: "start_log"; isoDate: string; createdAt: number }
    | { type: "resume_pending_log"; createdAt: number };

  /**
   * If a user is mid-log and enters the payment flow, we temporarily stash
   * their draft here so `clearActiveFlow()` doesn't wipe it.
   */
  pausedLogDraft?: {
    pendingLogParts: string[];
    pendingLogDate?: string;
    lastLogMessageAt?: number;
    flowStartedAt?: number;
    autoSavePromptSent?: boolean;
  };
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
  session.awaitingPaymentEmail = false;
  session.pendingPaymentEmail = undefined;
  session.pendingPaystackRef = undefined;
  session.pendingManualPaymentId = undefined;
  session.pendingVoiceTranscription = undefined;
  session.pendingRefinedContent = undefined;
  session.refiningLogId = undefined;
  session.flowStartedAt = undefined;
  session.lastLogMessageAt = undefined;
  session.autoSavePromptSent = undefined;

  // NOTE: intentionally does NOT clear `postPaymentAction`.
  // Payment flows call clearActiveFlow, and we still want to resume the
  // original user action after payment succeeds.
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
