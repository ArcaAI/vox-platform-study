/**
 * Request/response types for the stateless, v1-compat summarization surface.
 *
 * Wire shapes are snake_case and FROZEN — they mirror the v1 SMR contract
 * served by `POST /api/smr/api/v1/presummary` and `POST /api/smr/api/v1/summary/sync`
 * (`apps/api/src/modules/text-compat/`). No consultation is required: the
 * caller posts a transcript and gets a summary back. Renaming any field here
 * would break the wire format — do not camelCase these.
 */

// -----------------------------------------------------------------------------
// Session data (SyncSummaryRequest.session_data)
// -----------------------------------------------------------------------------

/**
 * One transcript turn inside `SessionData.conversation_segments`.
 * Mirrors v1 `ConversationSegment` (frozen v1 contract).
 */
export interface ConversationSegment {
  /** Speaker label, e.g. "patient" / "provider". Frozen v1 field name. */
  speaker: string;
  /** Spoken text. Frozen v1 field name. */
  text: string;
  /** ISO-8601 timestamp of the turn. Frozen v1 field name. */
  timestamp: string;
  /** ASR confidence 0.0-1.0. Frozen v1 field name. */
  confidence?: number;
  /** Free-form per-segment metadata. Frozen v1 field name. */
  metadata?: Record<string, unknown>;
}

/**
 * A structured investigation result inside `SessionData.test_results`.
 * Mirrors v1 `TestResult` (frozen v1 contract).
 */
export interface TestResult {
  /** Frozen v1 field name. */
  test_name: string;
  /** Test type, e.g. "lab" / "imaging". Frozen v1 field name. */
  test_type: string;
  /** Result value/text. Frozen v1 field name. */
  result: string;
  /** ISO-8601 test date. Frozen v1 field name. */
  date?: string;
  /** Frozen v1 field name. */
  reference_range?: string;
  /** Status, e.g. Normal/Abnormal/Critical. Frozen v1 field name. */
  status?: string;
  /** Ordering provider. Frozen v1 field name. */
  ordering_provider?: string;
}

/**
 * A structured prior encounter inside `SessionData.previous_visits`.
 * Mirrors v1 `PreviousVisitRecord` (frozen v1 contract).
 */
export interface PreviousVisitRecord {
  /** ISO-8601 visit date. Frozen v1 field name. */
  visit_date: string;
  /** Frozen v1 field name. */
  visit_type: string;
  /** Frozen v1 field name. */
  chief_complaint: string;
  /** Frozen v1 field name. */
  provider?: string;
  /** Frozen v1 field name. */
  diagnosis?: string;
  /** Frozen v1 field name. */
  treatment?: string;
  /** Frozen v1 field name. */
  follow_up_plan?: string;
  /** Frozen v1 field name. */
  visit_summary?: string;
  /** Frozen v1 field name. */
  medications_prescribed?: string[];
  /** Frozen v1 field name. */
  tests_ordered?: string[];
}

/**
 * The session to summarize — body of `SyncSummaryRequest.session_data`.
 * Mirrors v1 `SessionData` (frozen v1 contract, `text-compat/dto/session-data.dto.ts`).
 *
 * `session_id` is an OPTIONAL free-form correlation string (NOT a v2
 * Consultation id) — it is echoed back on `SummaryResponse.session_id`; the
 * gateway synthesizes a `text-...` value when omitted.
 */
export interface SessionData {
  /** Optional session correlation id; echoed back. Not a v2 Consultation id. */
  session_id?: string;
  /** Frozen v1 field name. */
  patient_id?: string;
  /** Frozen v1 field name. */
  provider_id?: string;
  /** Frozen v1 field name. */
  session_type?: string;
  /** ISO-8601 session creation time. Frozen v1 field name; required. */
  created_at: string;
  /** Transcript turns. Frozen v1 field name. */
  conversation_segments?: ConversationSegment[];
  /** Free-form patient info/context. Frozen v1 field name. */
  patient_info?: Record<string, unknown>;
  /** Free-form session metadata (e.g. `{ language: "en" }`). Frozen v1 field name. */
  session_metadata?: Record<string, unknown>;
  /** Structured test results. Frozen v1 field name. */
  test_results?: TestResult[];
  /** Structured prior visits. Frozen v1 field name. */
  previous_visits?: PreviousVisitRecord[];
  /**
   * Deprecated/free-form on the wire (the gateway DTO types it `unknown` and
   * never validates its shape). Frozen v1 field name.
   */
  previous_visit_summary?: unknown;
  /** Plain-text alternative for test results. Frozen v1 field name. */
  test_results_text?: string;
  /** Plain-text alternative for prior visits. Frozen v1 field name. */
  previous_visits_text?: string;
  /** Department-aware pre-summary to fold into context. Frozen v1 field name. */
  pre_summary_text?: string;
}

// -----------------------------------------------------------------------------
// Requests
// -----------------------------------------------------------------------------

/**
 * Body of `POST /api/smr/api/v1/presummary` (v1 `PreSummaryRequest`, frozen
 * v1-compat contract). All fields optional; `temperature`/`max_tokens`
 * defaults (0.2 / 800) are applied server-side when omitted.
 */
export interface PreSummaryRequest {
  /** Current department; `null`/omitted → "General". Frozen v1 field name. */
  current_department?: string;
  /** Type of visit; `null`/omitted → "Medical examination". Frozen v1 field name. */
  visit_type?: string;
  /** Patient age as a string. Frozen v1 field name. */
  age?: string;
  /** Date of birth as a string. Frozen v1 field name. */
  dob?: string;
  /** Frozen v1 field name. */
  gender?: string;
  /** Recent vitals, pre-formatted as text. Frozen v1 field name. */
  formatted_vitals?: string;
  /** Recent test results, pre-formatted as text. Frozen v1 field name. */
  formatted_test_results?: string;
  /** Prior visits, pre-formatted as text. Frozen v1 field name. */
  formatted_previous_visits?: string;
  /** Output language code ("en" / "ml"); default "en". Frozen v1 field name. */
  language?: string;
  /**
   * Requesting doctor id. When set and the tenant+doctor DNA gate is on, the
   * doctor's DNA writing-style is applied to the pre-summary. Omit to use
   * department + visit-type only. Frozen v1 field name.
   */
  doctor_id?: string;
  /** Sampling temperature 0.0-2.0; default 0.2. Frozen v1 field name. */
  temperature?: number;
  /** Max output tokens 1-65536; default 800. Frozen v1 field name. */
  max_tokens?: number;
  /**
   * `true` streams the pre-summary as SSE (delta* + terminal `result`);
   * default `false` returns a single JSON body. Frozen v1 field name.
   */
  stream?: boolean;
}

/**
 * Body of `POST /api/smr/api/v1/summary/sync` (v1 `SyncSummaryRequest`,
 * frozen v1-compat contract).
 */
export interface SyncSummaryRequest {
  /** The session to summarize. Frozen v1 field name; required. */
  session_data: SessionData;
  /** Override the system prompt. Frozen v1 field name. */
  system_prompt?: string;
  /** Override the user prompt template. Frozen v1 field name. */
  user_prompt_template?: string;
  /** Sampling temperature 0.0-2.0. Frozen v1 field name. */
  temperature?: number;
  /** Max output tokens 1-32768. Frozen v1 field name. */
  max_tokens?: number;
  /** Free-form extra context. Frozen v1 field name. */
  context?: Record<string, unknown>;
  /**
   * `true` → EnhancedMedicalSummary; `false` → SimplifiedMedicalSummary;
   * default `false`. Frozen v1 field name.
   */
  use_enhanced_format?: boolean;
  /** Explicit department for prompt selection. Frozen v1 field name. */
  department?: string;
  /** Explicit visit type. Frozen v1 field name. */
  visit_type?: string;
  /**
   * Requesting doctor id. When set and the tenant+doctor DNA gate is on, the
   * doctor's DNA writing-style is applied to the summary. Frozen v1 field name.
   */
  doctor_id?: string;
  /** Medical specialty. Frozen v1 field name. */
  specialty?: string;
  /** Encounter context. Frozen v1 field name. */
  encounter_type?: string;
  /**
   * Include `session_data.pre_summary_text` in the summarization context;
   * default `false`. Frozen v1 field name.
   */
  include_pre_summary_in_context?: boolean;
  /**
   * DEPRECATED / ignored by the gateway — use `pre_summary_text` +
   * `include_pre_summary_in_context` instead. Frozen v1 field name, kept for
   * wire compatibility.
   */
  include_previous_visit_summary?: boolean;
  /**
   * `true` streams the summary as SSE (delta* + terminal `result`); default
   * `false` returns a single JSON body. Frozen v1 field name.
   */
  stream?: boolean;
  /**
   * `true` translates the transcript to English via Sarvam BEFORE
   * summarizing. Fail-open: on a translation error the original transcript
   * is summarized. Default `false`. Frozen v1 field name.
   */
  translate_to_english?: boolean;
}

// -----------------------------------------------------------------------------
// Responses
// -----------------------------------------------------------------------------

/** Token accounting on a `SummaryResponse`. Frozen v1 field names. */
export interface TokenUsage {
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  total_tokens?: number | null;
}

/**
 * Non-secret provider/format details echoed back on `SummaryResponse.metadata`.
 * `llm_provider` / `model_name` / `parsing_method` / `raw_llm_content` are
 * cosmetic v1-parity display labels — `raw_llm_content` is the same LLM text
 * already parsed into `summary`, so it exposes nothing beyond the returned
 * summary. Frozen v1 field names.
 */
export interface SummaryResponseMetadata {
  finish_reason?: string;
  temperature?: number | null;
  max_tokens?: number | null;
  use_enhanced_format: boolean;
  language?: string;
  specialty?: string | null;
  encounter_type?: string | null;
  /** Present only when pre-summary enrichment was applied. */
  pre_summary_text?: string;
  /** The provider that generated the summary (or the Foundry fallback). */
  llm_provider?: string | null;
  /** The model/deployment that generated the summary. */
  model_name?: string | null;
  /** How the LLM output was parsed. */
  parsing_method?: string | null;
  /** The raw LLM content string (same text parsed into `summary`). */
  raw_llm_content?: string | null;
}

/**
 * Response of `POST /api/smr/api/v1/summary/sync` (HTTP 200) and the
 * `result` frame of its streaming variant. `summary` is the parsed LLM
 * output (`EnhancedMedicalSummary | SimplifiedMedicalSummary`); its exact
 * shape is provider/format-dependent, so it is left as an open record rather
 * than guessed at. Frozen v1 field names.
 */
export interface SummaryResponse {
  summary_id: string;
  session_id: string;
  /** Parsed LLM object — shape varies by `use_enhanced_format`. */
  summary: Record<string, unknown>;
  created_at: string;
  processing_time_ms: number | null;
  token_usage: TokenUsage | null;
  confidence_score: number | null;
  metadata: SummaryResponseMetadata;
}

/** One bullet inside a `PreSummarySection`. Frozen v1 field name. */
export interface PreSummarySectionItem {
  text: string;
}

/** A titled group of bullets inside `StructuredPreSummary.sections`. Frozen v1 field names. */
export interface PreSummarySection {
  title: string;
  items: PreSummarySectionItem[];
}

/** The structured form of a pre-summary. Frozen v1 field names (`StructuredPreSummary`). */
export interface StructuredPreSummary {
  title: string;
  sections: PreSummarySection[];
}

/**
 * Response of `POST /api/smr/api/v1/presummary` (HTTP 200) and the `result`
 * frame of its streaming variant. Frozen v1 field names (`PreSummaryResponse`).
 */
export interface PreSummaryResponse {
  pre_summary: string;
  structured_data: StructuredPreSummary;
  created_at: string;
}

// -----------------------------------------------------------------------------
// Streaming events (SSE, `stream: true`)
// -----------------------------------------------------------------------------

/**
 * One frame of the SSE stream emitted by `POST /api/smr/api/v1/summary/sync`
 * (`stream: true`). Frame shapes verified against `text-compat.controller.ts`
 * `writeSse` calls: `delta`/`reasoning` carry accumulating text, `result`
 * carries the terminal `SummaryResponse`, `error` carries a PHI-redacted
 * detail string (never upstream content). `:keepalive` comment frames are
 * transport-level heartbeats and are not surfaced as events.
 */
export type SummaryStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'result'; data: SummaryResponse }
  | { type: 'error'; detail: string };

/**
 * One frame of the SSE stream emitted by `POST /api/smr/api/v1/presummary`
 * (`stream: true`). Same frame shapes as {@link SummaryStreamEvent}, with
 * `result` carrying the terminal `PreSummaryResponse` instead.
 */
export type PreSummaryStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'reasoning'; text: string }
  | { type: 'result'; data: PreSummaryResponse }
  | { type: 'error'; detail: string };
