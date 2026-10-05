/**
 * Consultation lifecycle wire vocabulary shared by the gateway, the admin console and both SDKs:
 * the seven-value status, the orthogonal processing marker, lifecycle events, capture/stop
 * results, feedback, the activity (history) read model and attachments. Pure types and const
 * arrays — no runtime dependencies.
 */

export const CONSULTATION_STATUSES = [
  'OPEN',
  'RECORDING',
  'PAUSED',
  'STOPPED',
  'APPROVED',
  'CLOSED_COMPLETE',
  'CLOSED_INCOMPLETE',
] as const;
export type ConsultationStatus = (typeof CONSULTATION_STATUSES)[number];

export const CONSULTATION_PROCESSING = [
  'IDLE',
  'FINALIZING_TRANSCRIPT',
  'SUMMARIZING',
  'PROCESSING_ATTACHMENT',
  'AWAITING_REVIEW',
  'FAILED',
] as const;
export type ConsultationProcessing = (typeof CONSULTATION_PROCESSING)[number];

export const CONSULTATION_CLOSED_REASONS = ['AUTO', 'MANUAL', 'APPROVED'] as const;
export type ConsultationClosedReason = (typeof CONSULTATION_CLOSED_REASONS)[number];

/** The pre-lifecycle twelve-value status, as spoken by older clients. */
export type LegacyConsultationStatus =
  | 'OPEN'
  | 'RECORDING'
  | 'DRAFT_PENDING_SENSORS'
  | 'PENDING_REVIEW'
  | 'SIGNED'
  | 'CLOSED'
  | 'REOPENED'
  | 'PRIMED'
  | 'DRAINING'
  | 'TIMED_OUT'
  | 'CLOSED_COMPLETE'
  | 'CLOSED_INCOMPLETE';

/** The `processingReason` a finished, ready-to-read note carries while `processing` is IDLE. */
export const NOTE_READY_REASON = 'NOTE_READY';

export interface NormalizedConsultationState {
  status: ConsultationStatus;
  processing: ConsultationProcessing;
  processingReason?: string | null;
}

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

/** Legacy value -> the status and the processing marker it implied. */
export const LEGACY_STATUS_MAP: Readonly<
  Record<LegacyConsultationStatus, NormalizedConsultationState>
> = {
  OPEN: { status: 'OPEN', processing: 'IDLE' },
  PRIMED: { status: 'OPEN', processing: 'IDLE' },
  REOPENED: { status: 'OPEN', processing: 'IDLE' },
  RECORDING: { status: 'RECORDING', processing: 'IDLE' },
  DRAINING: { status: 'STOPPED', processing: 'FINALIZING_TRANSCRIPT' },
  DRAFT_PENDING_SENSORS: { status: 'STOPPED', processing: 'SUMMARIZING' },
  PENDING_REVIEW: { status: 'STOPPED', processing: 'IDLE', processingReason: NOTE_READY_REASON },
  SIGNED: { status: 'APPROVED', processing: 'IDLE' },
  TIMED_OUT: { status: 'CLOSED_INCOMPLETE', processing: 'IDLE' },
  CLOSED: { status: 'CLOSED_COMPLETE', processing: 'IDLE' },
  CLOSED_COMPLETE: { status: 'CLOSED_COMPLETE', processing: 'IDLE' },
  CLOSED_INCOMPLETE: { status: 'CLOSED_INCOMPLETE', processing: 'IDLE' },
};

/**
 * Normalise a status string from either vocabulary. An explicit `processing` wins over the one
 * the legacy value implied. Returns null for a value in neither vocabulary.
 */
export function normalizeLegacyConsultationStatus(
  value: string,
  processing?: ConsultationProcessing,
): NormalizedConsultationState | null {
  const legacy = Object.prototype.hasOwnProperty.call(LEGACY_STATUS_MAP, value)
    ? LEGACY_STATUS_MAP[value as LegacyConsultationStatus]
    : undefined;
  if (legacy) {
    return {
      ...legacy,
      processing: processing ?? legacy.processing,
      // An explicit processing value replaces the one the legacy value implied, reason included.
      ...(processing && processing !== legacy.processing ? { processingReason: undefined } : {}),
    };
  }
  if ((CONSULTATION_STATUSES as readonly string[]).includes(value)) {
    return { status: value as ConsultationStatus, processing: processing ?? 'IDLE' };
  }
  return null;
}

// ── Lifecycle events ────────────────────────────────────────────────────────────────────────

export const LIFECYCLE_EVENT_TYPES = [
  'opened',
  'encounter_appended',
  'started',
  'paused',
  'stopped',
  'transcript_final',
  'processing_changed',
  'approved',
  'closed',
  'reopened',
] as const;
export type LifecycleEventType = (typeof LIFECYCLE_EVENT_TYPES)[number];

export interface LifecycleEvent {
  type: LifecycleEventType;
  consultationId: string;
  status: ConsultationStatus;
  processing: ConsultationProcessing;
  processingReason?: string;
  closedReason?: ConsultationClosedReason;
  encounterSeq?: number;
  version: number;
  at: string;
  seq: number;
}

// ── Capture / stop / consultation response additions ───────────────────────────────────────

export interface CaptureState {
  consultationId: string;
  status: ConsultationStatus;
  processing: ConsultationProcessing;
  encounterSeq: number;
  sessionId?: string;
  recording: boolean;
  paused: boolean;
  version: number;
  updatedAt: string;
}

export interface StopResult extends CaptureState {
  finalTranscript: {
    state: 'complete' | 'pending';
    contextItemId: string | null;
    versionNumber: number | null;
    segmentCount: number;
    lastSegmentSeq: number;
  };
}

export interface EncounterSummary {
  seq: number;
  visitType: string;
  externalRef: string | null;
  startedAt: string;
  endedAt: string | null;
  recordingStartMs: number | null;
  recordingEndMs: number | null;
}

export interface ApprovalSummary {
  id: string;
  approvedAt: string;
  approvedBy: string;
  snapshotHash: string;
  itemCount: number;
}

/** Fields the lifecycle adds to the consultation response. */
export interface ConsultationLifecycleFields {
  processing: ConsultationProcessing;
  processingReason: string | null;
  lastActivityAt: string;
  autoCloseAt: string | null;
  reopenCount: number;
  closedReason: ConsultationClosedReason | null;
  closedAt: string | null;
  reopenAllowed: boolean;
  currentEncounterSeq: number;
  encounters: EncounterSummary[];
  approval: ApprovalSummary | null;
  recordable?: boolean;
  encounterAppended?: boolean;
}

// ── Feedback ────────────────────────────────────────────────────────────────────────────────

export const FEEDBACK_RATINGS = ['up', 'down', 'cleared'] as const;
export type FeedbackRating = (typeof FEEDBACK_RATINGS)[number];

export const FEEDBACK_TARGET_KINDS = [
  'NOTE',
  'SECTION',
  'SEGMENT',
  'ENTITY',
  'TRANSCRIPT',
  'RECAP',
] as const;
export type FeedbackTargetKind = (typeof FEEDBACK_TARGET_KINDS)[number];

export interface FeedbackTarget {
  kind: FeedbackTargetKind;
  contextItemId: string;
  versionNumber?: number;
  sectionKey?: string;
  documentKey?: string;
  entityRef?: string;
}

/** Tenant-configurable reason code; the effective list comes from settings. */
export type FeedbackReasonCode = string & { readonly __feedbackReasonCode?: never };

export const DEFAULT_FEEDBACK_REASON_CODES: readonly FeedbackReasonCode[] = [
  'missing_information',
  'wrong_medication_or_dose',
  'wrong_patient_detail',
  'made_something_up',
  'wrong_section',
  'too_long',
  'wrong_language',
];

// ── Attachments ─────────────────────────────────────────────────────────────────────────────

export const ATTACHMENT_KINDS = ['document', 'image', 'audio', 'case_note'] as const;
export type AttachmentKind = (typeof ATTACHMENT_KINDS)[number];

export const ATTACHMENT_STATUSES = [
  'INTENT',
  'UPLOADED',
  'PROCESSING',
  'READY',
  'FAILED',
  'EXPIRED',
] as const;
export type AttachmentStatus = (typeof ATTACHMENT_STATUSES)[number];

export interface AttachmentIntentResponse {
  attachmentId: string;
  status: 'INTENT';
  kind: AttachmentKind;
  uploadMode: string;
  uploadUrl: string | null;
  uploadMethod: 'PUT';
  uploadHeaders: Record<string, string>;
  uploadExpiresAt: string;
  intentExpiresAt: string;
  maxSizeBytes: number;
}

export interface AttachmentCompleteResponse {
  attachmentId: string;
  status: 'READY' | 'PROCESSING';
  kind: AttachmentKind;
  mime: string;
  sizeBytes: number;
  sha256: string;
  mediaId: string | null;
  contextItemId: string | null;
  transcriptionJobId?: string;
}

// ── Activity (history) read model ──────────────────────────────────────────────────────────

export const ACTIVITY_KINDS = [
  'TRANSCRIPT_SEGMENT',
  'FULL_TRANSCRIPT',
  'NOTE',
  'PRE_SUMMARY',
  'CASE_NOTE',
  'ATTACHMENT',
  'RECORDING',
  'FACT_LEDGER',
  'ENCOUNTER_RECAP',
  'STRUCTURED',
  'FEEDBACK',
  'LIFECYCLE',
] as const;
export type ActivityKind = (typeof ACTIVITY_KINDS)[number];

export interface EncounterBlock {
  seq: number;
  visitType: string;
  externalRef: string | null;
  startedAt: string;
  endedAt: string | null;
  recordingStartMs: number | null;
  recordingEndMs: number | null;
  gapAfter?: { fromAt: string; toAt: string; durationMs: number };
}

export interface RunSummary {
  runId: string;
  workflowSlug: string;
  workflowVersion: number | string;
  agentSlug: string;
  agentVersion: number | string;
  model: string;
  provider: string;
  durationMs: number;
  tokensIn: number;
  tokensOut: number;
  contextUsed: number;
  contextWindow: number;
  costMicros: number | null;
  costBasis: string | null;
  stopReason: string | null;
  startedAt: string;
}

export interface ActivityRunRecord extends RunSummary {
  id: string;
  nodeId: string;
  nodeLabel?: string;
  activityKind: string;
  outputCap: number | null;
  deployment: string | null;
  endedAt: string;
  versionNumber: number;
}

export interface ItemVersionSummary {
  versionNumber: number;
  changeSource: string;
  changedBy: string | null;
  changeReason?: string | null;
  createdAt: string;
}

export interface ItemVersionDetail extends ItemVersionSummary {
  contextItemId: string;
  content: string | null;
  mediaId?: string | null;
}

export interface ActivityItemEntry {
  entryType: 'item';
  id: string;
  kind: ActivityKind;
  encounterSeq: number | null;
  occurredAt: string;
  source: string;
  actor?: { userId: string; credentialClass?: string };
  latestVersion: {
    number: number;
    content?: string | null;
    mediaId?: string | null;
    changeSource: string;
    changedBy: string | null;
    createdAt: string;
  };
  versionCount: number;
  edited: boolean;
  lastEditedAt?: string;
  versions?: ItemVersionSummary[];
  run?: RunSummary;
  feedback?: { up: number; down: number };
  segment?: { seq: number; speaker: string | null; t0Ms: number; t1Ms: number };
  media?: { mediaId: string; url?: string; durationMs?: number };
}

export interface ActivitySegmentRunEntry {
  entryType: 'segment_run';
  runId: string;
  encounterSeq: number;
  firstSeq: number;
  lastSeq: number;
  count: number;
  t0Ms: number;
  t1Ms: number;
  speakers: string[];
  occurredAt: string;
  preview: string;
  edited: boolean;
}

export interface ActivityFeedbackEntry {
  entryType: 'feedback';
  id?: string;
  occurredAt?: string;
  rating: FeedbackRating | null;
  reasonCodes: FeedbackReasonCode[];
  comment: string | null;
  target: FeedbackTarget | null;
  actor: { userId: string; credentialClass?: string };
  clientApp?: string;
  surface?: string;
  provenance?: Record<string, unknown>;
}

export interface ActivityLifecycleEntry {
  entryType: 'lifecycle';
  at: string;
  type: LifecycleEventType | string;
  actor?: { userId: string; credentialClass?: string };
}

export type ActivityEntry =
  | ActivityItemEntry
  | ActivitySegmentRunEntry
  | ActivityFeedbackEntry
  | ActivityLifecycleEntry;

export interface Aggregates {
  aiRunCount: number;
  tokensIn: number;
  tokensOut: number;
  costMicros: number;
  costBasis: string[];
  editedItems: number;
  feedbackUp: number;
  feedbackDown: number;
}

export interface ConsultationActivityPage {
  consultationId: string;
  status: ConsultationStatus;
  processing: ConsultationProcessing;
  processingReason?: string;
  encounters: EncounterBlock[];
  items: ActivityEntry[];
  nextCursor: string | null;
  hasMore: boolean;
  aggregates?: Aggregates;
}

/** A source a recap line cites: a transcript segment (seekable via `t0Ms`) or an attachment. */
export interface RecapCitation {
  itemId: string;
  versionNumber: number;
  label: string;
  kind: 'segment' | 'attachment';
  t0Ms?: number;
}

export interface RecapLine {
  text: string;
  citations: RecapCitation[];
}

/** The six fixed recap keys, in display order. */
export const RECAP_SECTION_KEYS = ['reason', 'findings', 'medicines', 'sent_for', 'since_then', 'still_open'] as const;
export type RecapSectionKey = (typeof RECAP_SECTION_KEYS)[number];

export interface EncounterRecap {
  encounterSeq: number;
  contextItemId: string;
  versionNumber: number;
  text: string;
  sections?: Array<{ key: string; label?: string; text: string; lines?: RecapLine[] }>;
  generatedAt: string;
  ledgerContextItemId: string;
}
