/**
 * The consultation LIFECYCLE vocabulary — the seven-value status, the orthogonal processing marker,
 * lifecycle events, capture/stop results, feedback, attachments and the history read model.
 *
 * The wire types are re-exported from `@arcaai/types` (a `devDependency` whose declarations the
 * build inlines, see `tsup.config.ts`), so the gateway, the console and both SDKs share one
 * definition. They are exported under `Lifecycle`-qualified names where the bare name is already
 * taken by the pre-lifecycle twelve-value `ConsultationStatus` this package still exports.
 */

import type {
  ConsultationLifecycleFields,
  ConsultationProcessing,
  ConsultationStatus as LifecycleStatus,
  FeedbackReasonCode,
  FeedbackRating,
  FeedbackTarget,
} from '@arcaai/types';

export type {
  ActivityEntry,
  ActivityKind,
  ActivityRunRecord,
  AttachmentCompleteResponse,
  AttachmentIntentResponse,
  AttachmentKind,
  AttachmentStatus,
  CaptureState,
  ConsultationActivityPage,
  ConsultationClosedReason,
  ConsultationLifecycleFields,
  ConsultationProcessing,
  EncounterBlock,
  EncounterRecap,
  EncounterSummary,
  FeedbackRating,
  FeedbackReasonCode,
  FeedbackTarget,
  FeedbackTargetKind,
  LifecycleEvent,
  LifecycleEventType,
  RunSummary,
  StopResult,
} from '@arcaai/types';
export type { ConsultationStatus as ConsultationLifecycleStatus } from '@arcaai/types';

/**
 * What `approve` / `close` / `reopen` return: the consultation as the gateway now holds it.
 * Read {@link ConsultationState.version} for the next `If-Match`.
 */
export interface ConsultationState extends Partial<ConsultationLifecycleFields> {
  id: string;
  status: LifecycleStatus;
  processing: ConsultationProcessing;
  /** Row `_version` — the operand of the next `If-Match`. */
  version: number;
  approvedAt?: string;
  closedAt?: string | null;
  updatedAt?: string;
}

/** Options shared by the handle's verbs. */
export interface ConsultationHandleCallOptions {
  signal?: AbortSignal;
}

/** Options for {@link ConsultationHandle.start}. */
export interface StartCaptureOptions extends ConsultationHandleCallOptions {
  /** A published `SPEECH_TO_TEXT` agent lineage key. Omit it and the gateway resolves one. */
  agentSlug?: string;
  /** The SPOKEN language for this session; defaults to the consultation's declared one. */
  language?: string;
}

/** Options for {@link ConsultationHandle.stop}. */
export interface StopCaptureOptions extends ConsultationHandleCallOptions {
  /** Hold the response until the final transcript is rebuilt. Default `true`. */
  waitForFinal?: boolean;
  /** Save the last running-summary snapshot before teardown. */
  persistSnapshot?: boolean;
  /** Corrections the clinician accepted off the live-assist feed. */
  acceptedProposals?: unknown[];
  /** Per-call timeout; the call waits on the final transcript. Default 120 000 ms. */
  timeoutMs?: number;
}

/** Options for the `If-Match` verbs (`approve`, `close`, `reopen`). */
export interface ConsultationCommandOptions extends ConsultationHandleCallOptions {
  /** Overrides the handle's own version. When omitted the handle sends the version it last saw. */
  ifMatch?: string | number;
}

export interface ApproveOptions extends ConsultationCommandOptions {
  clinicianUserId?: string;
  overrideSafetyFlag?: boolean;
}

export interface CloseOptions extends ConsultationCommandOptions {
  clinicianUserId?: string;
}

export interface ReopenOptions extends ConsultationCommandOptions {
  /** At most 256 characters. */
  reason?: string;
  /**
   * A service-account caller may name the clinician the reopen is for; without it the gateway
   * uses the consultation's own clinician. A human caller reopens as themselves.
   */
  clinicianUserId?: string;
}

/** Options for {@link ConsultationHandle.generateSummary}. */
export interface GenerateSummaryOptions extends ConsultationHandleCallOptions {
  /** The language the note is written in. */
  outputLanguage?: string;
  /** Regenerate only these sections; the others are carried over from the latest note version. */
  sectionKeys?: string[];
  /** Wait for the job and return the finished note. Default `false`. */
  wait?: boolean;
  pollIntervalMs?: number;
}

/** What {@link ConsultationHandle.sendAttachment} accepts as `kind`. `pdf` is sent as `document`. */
export type AttachmentInputKind = 'pdf' | 'document' | 'image' | 'audio' | 'case_note';

/** The file itself. A string is sent as UTF-8 (the natural form for a `case_note`). */
export type AttachmentData = Uint8Array | ArrayBuffer | Blob | string;

export interface AttachmentInput {
  kind: AttachmentInputKind;
  data: AttachmentData;
  mime: string;
  name?: string;
  /** Lower-case hex SHA-256 of `data`. Computed with WebCrypto when omitted. */
  sha256?: string;
}

export type AttachmentProgressPhase = 'hashing' | 'intent' | 'uploading' | 'completing' | 'processing' | 'ready';

export interface SendAttachmentOptions extends ConsultationHandleCallOptions {
  onProgress?: (phase: AttachmentProgressPhase, attachmentId?: string) => void;
  /** `'feedback'` stores the file as feedback evidence only. Default `'attachment'`. */
  purpose?: 'attachment' | 'feedback';
  encounterSeq?: number;
  /** Overrides the generated key. One key covers the whole logical upload, retries included. */
  idempotencyKey?: string;
  /** Delay between polls while the gateway processes the upload. Default 2 000 ms. */
  pollIntervalMs?: number;
  /** Give up polling after this long. Default 300 000 ms. */
  pollTimeoutMs?: number;
}

/** The finished upload. `status` is `'READY'` once the gateway has processed it. */
export interface AttachmentResult {
  attachmentId: string;
  status: 'READY' | 'PROCESSING';
  kind: string;
  mime: string;
  sizeBytes: number;
  sha256: string;
  mediaId: string | null;
  contextItemId: string | null;
  transcriptionJobId?: string;
}

interface FeedbackCommon {
  /** Files to attach as evidence; each is uploaded first with `purpose: 'feedback'`. */
  attachments?: AttachmentInput[];
  /** Ids of attachments you already uploaded with `purpose: 'feedback'`. */
  attachmentIds?: string[];
  client?: { app?: string; surface?: string };
  idempotencyKey?: string;
}

export type FeedbackInput =
  | (FeedbackCommon & {
      kind: 'rating';
      target: FeedbackTarget;
      rating: FeedbackRating;
      reasonCodes?: FeedbackReasonCode[];
      comment?: string;
    })
  | (FeedbackCommon & { kind: 'comment'; target?: FeedbackTarget; comment: string })
  | (FeedbackCommon & {
      /** Replace the content of the target note, section, segment or transcript. `correction` is an alias. */
      kind: 'edit' | 'correction';
      target: FeedbackTarget;
      content: string;
      expectedVersion?: number;
      comment?: string;
    });

export interface FeedbackResponse {
  id: string;
  consultationId: string;
  target: FeedbackTarget | null;
  rating: FeedbackRating | null;
  reasonCodes: FeedbackReasonCode[];
  comment: string | null;
  attachmentIds: string[];
  correction: { contextItemId: string; versionNumber: number } | null;
  isLatest: boolean;
  createdAt: string;
  [key: string]: unknown;
}

export interface FeedbackReasonCodesResponse {
  items: Array<{ code: string; label: string; appliesTo?: string[] }>;
  source: 'tenant' | 'system';
}

/** Filters for {@link ConsultationHandle.history}. */
export interface HistoryQuery extends ConsultationHandleCallOptions {
  cursor?: string;
  /** Page size, at most 100. */
  limit?: number;
  kinds?: string[];
  encounterSeq?: number;
  edited?: boolean;
  grouping?: 'runs' | 'none';
  include?: 'versions';
}

/** The result of {@link ConsultationHandle.start}. */
export interface CaptureHandle {
  sessionId: string;
  /** The live socket: stream PCM16 into it with `sendPcm16`. */
  socket: import('../core/realtime-stt-socket').RealtimeSttSocket;
  state: import('@arcaai/types').CaptureState;
  /** `true` when a paused capture was resumed instead of a new session being opened. */
  resumed: boolean;
}

export type CaptureStateName = 'capturing' | 'paused' | 'pause_expired' | 'stopped';

/** The `processingReason` a finished, ready-to-read note carries while `processing` is IDLE. */
export const NOTE_READY_REASON = 'NOTE_READY';

/**
 * A note is ready to read when the consultation is STOPPED and either processing is IDLE with the
 * NOTE_READY reason, or AWAITING_REVIEW (a human must look). Never infer it from `status` alone.
 */
export function isNoteReady(state: {
  status: string;
  processing: string;
  processingReason?: string | null;
}): boolean {
  return (
    state.status === 'STOPPED' &&
    ((state.processing === 'IDLE' && state.processingReason === NOTE_READY_REASON) ||
      state.processing === 'AWAITING_REVIEW')
  );
}
