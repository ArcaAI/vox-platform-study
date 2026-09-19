/**
 * Wire types mirroring the DNA writing-style SELF plane
 * (DnaWritingStyleController + @arcaai/applications DTOs — the console cannot
 * import those server packages, so the shapes are declared here once).
 * Deliberately independent from the admin feature's copies: features never
 * import each other (rule 13).
 */

/** DnaReportResponse. `version` is the OCC row token, NOT the history counter. */
export interface DnaReport {
  id: string;
  doctorId: string;
  /** Human-readable doctor username resolved server-side (DnaReportResponse contract). */
  doctorUsername?: string;
  reportData?: Record<string, unknown>;
  styleText?: string;
  /** Whether this is the doctor's active/default report. */
  isLatest: boolean;
  /** Human-meaningful DnaVersion history counter (distinct from `version`). */
  currentVersionNumber: number;
  createdAt: string;
  updatedAt: string;
  resourceStatus?: 'ENABLED' | 'DISABLED';
  /** Row `_version` for If-Match optimistic concurrency (ETag mirrors it). */
  version: number;
}

/** DnaVersionResponse — one row of the report's version timeline. */
export interface DnaVersion {
  id: string;
  dnaReportId: string;
  versionNumber: number;
  reportData?: Record<string, unknown>;
  styleText?: string;
  changeReason?: string;
  changedBy?: string;
  createdAt: string;
}

/** GenerateDnaReportRequest — every field optional; `{}` is a valid body. */
export interface GenerateDnaStyleRequest {
  /** Text samples for analysis (gathered from ContextItems when omitted). */
  textSamples?: string[];
  promptTemplateId?: string;
  /** Edited summary text to seed the DNA analysis. */
  editedSummary?: string;
  /** Historical source item ids seeding a generate-from-history run. */
  sourceIds?: string[];
}

/** DNA redaction/rewrite rule (mirrors the harness `RedactionRule` shape). */
export type RedactionRuleType = 'remove' | 'rewrite';
export type RedactionMatchKind = 'literal' | 'regex' | 'category';

export interface RedactionRule {
  id: string;
  type: RedactionRuleType;
  match: RedactionMatchKind;
  pattern: string;
  /** For `rewrite` rules: the literal replacement (omit for a semantic TEXT rewrite). */
  replacement?: string;
  note?: string;
}

/** The persisted container shape (`{ rules: [...] }`) — GET my-style/redaction-rules. */
export interface RedactionRuleSet {
  rules: RedactionRule[];
}

/** UpdateDnaReportRequest (self PATCH — If-Match required, 428/412). */
export interface UpdateMyReportRequest {
  reportData?: Record<string, unknown>;
  styleText?: string;
  /**
   * the doctor's DNA redaction/rewrite rule set. Sent as
   * `{ rules: [...] }`; the gateway validates the shape on write and stores it
   * encrypted-at-rest. Pass `{ rules: [] }` to clear.
   */
  redactionRules?: RedactionRuleSet;
  changeReason?: string;
  /** Derived from the read ETag by the client; header overrides it server-side. */
  expectedVersion?: number;
}

/**
 * DnaSettingsResponse — the per-doctor DNA on/off settings.
 * `effective = tenantEnabled && (doctorToggle ?? true)`; `version` is the
 * DOCTOR-scope policy row's OCC token (0 when no override row exists yet).
 */
export interface DnaSettings {
  /** The doctor's explicit toggle (null = inherit / implicit opt-in). */
  doctorToggle: boolean | null;
  tenantEnabled: boolean;
  effective: boolean;
  version: number;
}

/** UpdateDnaSettingsRequest — PUT body for the doctor DNA on/off switch. */
export interface UpdateDnaSettingsRequest {
  /** true = opt-in, false = opt-out, null = clear the override. */
  enabled: boolean | null;
  /** Free-text reason recorded on the WORM change row. */
  reason?: string;
  /** Current DOCTOR-row version for OCC (from a prior GET; omit when 0). */
  expectedVersion?: number;
}

/**
 * DnaErasureResponse — the shared body of BOTH erasure routes
 * (DELETE my-style and DELETE :reportId). Counts are what was actually
 * soft-deleted, so an idempotent re-run reports zeros.
 */
export interface DnaErasureResult {
  doctorId: string;
  deletedReports: number;
  deletedVersions: number;
}

/** DnaJobResponseDto — POST generate acknowledgement. */
export interface DnaJob {
  /** BullMQ job id — poll/stream key for progress. */
  jobId: string;
  status: string;
}

export type DnaJobState = 'queued' | 'processing' | 'completed' | 'failed';

/** DnaJobStatusResponseDto — GET jobs/:jobId and the SSE `status` event payload. */
export interface DnaJobStatus {
  jobId: string;
  status: DnaJobState;
  /** 0..100. */
  progress: number;
  /** Present once completed. */
  result?: unknown;
  /** Present once failed. */
  error?: string;
}

/**
 * TASK-974 §4.1 — the DNA writing-sample INGEST surface (frame 53, F-6). Reader beware: this is
 * a SEPARATE route family from `generate` above — `generate` gathers from the caller's
 * ContextItems or an ad-hoc sample bag, while `ingest` submits a TIME-ORDERED corpus the platform
 * has not seen and queues the hidden `dna-writing-style-analyst` agent over it
 * (`IngestDnaWritingSamplesRequest` / `DnaIngestJobResponse` — `packages/applications/src/services/
 * dna-writing-style/dto/`). No SSE on this route (README §4.1) — `useDnaIngestJobProgress` polls.
 */

/** DnaWritingSampleDto.kind — explainability only; never gates how the sample is treated. */
export const DNA_WRITING_SAMPLE_KINDS = ['CASE_NOTE', 'WORK_NOTE', 'OTHER'] as const;
export type DnaWritingSampleKind = (typeof DNA_WRITING_SAMPLE_KINDS)[number];

/**
 * Per-batch bounds mirrored from `IngestDnaWritingSamplesRequest`/`DNA_INGEST_LIMITS`
 * (`packages/applications/src/services/dna-writing-style/dto/ingest-dna-writing-samples.request.ts`)
 * — enforced client-side before submit so a rejected batch is never a surprise after typing.
 */
export const DNA_INGEST_LIMITS = {
  maxItems: 200,
  maxItemChars: 20_000,
  /** Σ over every sample's `text`; a cross-field bound the server enforces, mirrored here for the same reason. */
  maxTotalChars: 400_000,
} as const;

/** DnaWritingSampleDto — one item of an ingest batch. */
export interface DnaWritingSample {
  /** 1..20000 chars. */
  text: string;
  /** ISO-8601 date-time — the time-series key samples are ordered (and truncated) by. */
  writtenAt: string;
  /** Server default `'OTHER'` when omitted. */
  kind?: DnaWritingSampleKind;
  /** ≤ 200 chars, caller's own record locator — explainability only, never persisted on the report. */
  sourceRef?: string;
}

/** IngestDnaWritingSamplesRequest — POST /ingest body. */
export interface IngestDnaWritingSamplesRequest {
  /**
   * REQUIRED for a machine caller — never sent by this console. A human caller omits it to
   * ingest their OWN samples; naming another clinician needs SUPER_ADMIN or TENANT_ADMIN and is
   * reachable only through the Advanced (raw JSON) editor, not the structured form.
   */
  clinicianUserId?: string;
  /** 1..200 items, in any order — the server sorts them by `writtenAt`. */
  items: DnaWritingSample[];
}

/** The accepted batch's time span — echoed so the caller can see what the server understood. */
export interface DnaIngestWindow {
  /** ISO-8601 `writtenAt` of the OLDEST accepted sample. */
  from: string;
  /** ISO-8601 `writtenAt` of the NEWEST accepted sample. */
  to: string;
}

/** DnaIngestJobResponse — the 202 body of `POST dna-writing-styles/ingest`. */
export interface DnaIngestJobResponse {
  /** Poll `GET ingest/jobs/{jobId}` with it. */
  jobId: string;
  /** Always `PENDING` on acceptance; the job has been enqueued, not run. */
  status: 'PENDING';
  /** The clinician the profile will belong to — RESOLVED, so a caller who omitted it sees whom the server chose. */
  clinicianUserId: string;
  acceptedItems: number;
  window: DnaIngestWindow;
}

/**
 * DnaJobStatusResponseDto mirror — `GET dna-writing-styles/ingest/jobs/:jobId`. Same shape as
 * `DnaJobStatus` above; kept as its own type because this route has no SSE twin and `progress`
 * is not always reported (unlike the streamed `generate` job).
 */
export interface DnaIngestJobStatus {
  jobId: string;
  status: DnaJobState;
  /** 0..100, when reported. */
  progress?: number;
  /** Present once completed. */
  result?: unknown;
  /** Present once failed. */
  error?: string;
}
