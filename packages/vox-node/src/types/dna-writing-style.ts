/**
 * DNA writing-style ingest types — `hope.dnaWritingStyle.*` (TASK-974).
 *
 * The business-plane surface for submitting a clinician's time-ordered
 * writing samples (case notes, work notes, …) so the platform's hidden
 * `dna-writing-style-analyst` agent can regenerate their writing-style
 * report and long-term memory. Mirrors
 * `apps/api/src/modules/dna-writing-style/dna-writing-style-ingest.controller.ts`
 * (`IngestDnaWritingSamplesRequest` / `DnaIngestJobResponse` /
 * `DnaJobStatusResponseDto`) verbatim — see
 * `docs/implementation/TASK-974-DNA-Writing-Style-Hidden-Agent-And-Ingest-API/README.md`
 * §4.1/§4.5, frozen for this lane.
 *
 * Recall/redaction into summarization output, and the SYNCHRONOUS
 * `dna-writing-styles/generate` trigger, are pre-existing and out of scope
 * here — this module is the INGEST surface only.
 */

/** One writing sample's provenance kind. Server default is `'OTHER'` when omitted. */
export type DnaWritingSampleKind = 'CASE_NOTE' | 'WORK_NOTE' | 'OTHER';

/** One item of a `DnaWritingSamplesIngestRequest.items` batch — `writtenAt` is the time-series key the processor sorts on. */
export interface DnaWritingSample {
  /** 1..20000 chars. */
  text: string;
  /** ISO-8601 date-time. */
  writtenAt: string;
  /** Default `'OTHER'` server-side when omitted. */
  kind?: DnaWritingSampleKind;
  /** ≤ 200 chars, opaque caller reference — explainability only, never echoed back with content. */
  sourceRef?: string;
}

/** Body of `POST /api/v1/dna-writing-styles/ingest`. */
export interface DnaWritingSamplesIngestRequest {
  /**
   * REQUIRED for an API-key or service-account caller — a machine caller has
   * no "self" to act as. A human (JWT) caller omits it to act as themself;
   * naming another clinician is allowed only for a caller holding
   * SUPER_ADMIN or TENANT_ADMIN. Must belong to the caller's tenant — a
   * cross-tenant id answers 404 (404-over-403).
   */
  clinicianUserId?: string;
  /** 1..200 items, time-ordered by `writtenAt` server-side (submission order does not matter). Σ `text` length ≤ 400000 chars, else `400 DNA_INGEST_TOO_LARGE`. */
  items: DnaWritingSample[];
}

/** Response body of `POST /api/v1/dna-writing-styles/ingest` (HTTP 202). */
export interface DnaIngestJobResponse {
  jobId: string;
  status: 'PENDING';
  clinicianUserId: string;
  acceptedItems: number;
  window: { from: string; to: string };
}

/**
 * Response body of `GET /api/v1/dna-writing-styles/ingest/jobs/{jobId}`.
 * Mirrors the existing `DnaJobStatusResponseDto`.
 */
export interface DnaIngestJobStatus {
  jobId: string;
  status: 'queued' | 'processing' | 'completed' | 'failed';
  /** Progress percentage, when reported. */
  progress?: number;
  /** Present once `status` is `'completed'`. */
  result?: unknown;
  /** Present once `status` is `'failed'`. */
  error?: string;
}
