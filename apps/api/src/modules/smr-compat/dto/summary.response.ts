/**
 * v1 response shapes for the compat summary endpoints
 * (SMR_Summary_Endpoints.md §3.2/§3.3/§4.2; frozen TASK-560 §5.4/§5.5).
 *
 * These are response types only — they never pass through the request
 * `ValidationPipe`, so plain TypeScript interfaces (not class-validator DTOs)
 * are used. The `summary` / `structured_data` bodies are the parsed LLM output
 * and are shaped defensively (unknown/extra keys tolerated), so they are typed
 * as open records.
 */

export interface TokenUsage {
  prompt_tokens?: number | null;
  completion_tokens?: number | null;
  total_tokens?: number | null;
}

/** Non-secret provider/format details echoed back. NEVER carries `raw_llm_content`. */
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
}

/** v1 `SummaryResponse` (HTTP 200) for `/summary/sync`. */
export interface SummaryResponse {
  session_id: string;
  /** `EnhancedMedicalSummary | SimplifiedMedicalSummary` — parsed LLM object. */
  summary: Record<string, unknown>;
  created_at: string;
  processing_time_ms: number | null;
  token_usage: TokenUsage | null;
  confidence_score: number | null;
  metadata: SummaryResponseMetadata;
}

export interface PreSummarySectionItem {
  text: string;
}

export interface PreSummarySection {
  title: string;
  items: PreSummarySectionItem[];
}

/** v1 `StructuredPreSummary`. */
export interface StructuredPreSummary {
  title: string;
  sections: PreSummarySection[];
}

/** v1 `PreSummaryResponse` (HTTP 200) for `/presummary`. */
export interface PreSummaryResponse {
  pre_summary: string;
  structured_data: StructuredPreSummary;
  created_at: string;
}
