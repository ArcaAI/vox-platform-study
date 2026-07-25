/**
 * Wire types for the `text/*` SMR proxy (matrix row 38). The gateway pipes
 * the Python service's Pydantic bodies through VERBATIM, so every field here
 * is snake_case on purpose — do NOT camelCase them. Sources of truth:
 * `apps/smr/src/smr/models/{responses,stream}.py` and the request DTOs in
 * `apps/api/src/modules/streaming/smr-proxy.controller.ts`.
 */

/** One catalog model of a provider entry. */
export interface SmrProviderModel {
    name: string;
    size?: string;
}

/** GET text/providers | text/guardrail-providers row. */
export interface SmrProvider {
    name: string;
    models: SmrProviderModel[];
    is_available: boolean;
    is_default?: boolean;
    default_model?: string;
}

export interface SmrResponseFormat {
    type: 'text' | 'json' | 'json_schema';
    json_schema?: Record<string, unknown>;
    strict?: boolean;
}

/** POST text/generate body (SmrGenerateRequest on the gateway). */
export interface GenerateTextRequest {
    prompt: string;
    system_prompt?: string;
    provider?: string;
    model?: string;
    temperature?: number;
    max_tokens?: number;
    top_p?: number;
    stream?: boolean;
    response_format?: SmrResponseFormat;
    context?: Record<string, unknown>;
}

export interface SmrTokenUsage {
    prompt_tokens: number;
    completion_tokens: number;
    total_tokens: number;
}

/** Sync generation result (SMR GenerateResponse). */
export interface GenerateTextResponse {
    task_id: string;
    status: string;
    content: string;
    reasoning?: string;
    provider: string;
    model: string;
    usage: SmrTokenUsage;
    latency_ms: number;
    finish_reason: string;
    created_at: string;
}

/** stream: true acknowledgement (SMR StreamingGenerateResponse). */
export interface StreamingGenerateAck {
    task_id: string;
    status: string;
    stream_url: string;
    created_at: string;
}

export type GenerateOutcome = GenerateTextResponse | StreamingGenerateAck;

/** Discriminates the streaming acknowledgement from the sync body. */
export function isStreamingAck(outcome: GenerateOutcome): outcome is StreamingGenerateAck {
    return 'stream_url' in outcome;
}

export type AssembledGenerationType = 'pre-summary' | 'summary';
export type AssembledVisitType = 'new_visit' | 'referral';

/** POST text/generate/assembled body — EXACTLY one of context_item_ids | message. */
export interface AssembledGenerateRequest {
    type: AssembledGenerationType;
    visit_type?: AssembledVisitType;
    context_item_ids?: string[];
    message?: string;
    prompt_template_id?: string;
    dna_writing_style_id?: string;
    provider?: string;
    model?: string;
    temperature?: number;
    max_tokens?: number;
    stream?: boolean;
    /** GLOBAL_ADMIN / TENANT_ADMIN only — the gateway 403s anyone else. */
    debug?: boolean;
}

/** `_debug` assembly meta appended when debug: true (admin-only). */
export interface AssembledDebugMeta {
    assembled: boolean;
    type: string;
    visit_type?: string;
    prompt_template_id?: string;
    prompt_template_name?: string;
    dna_writing_style_id?: string;
    context_item_ids?: string[];
    prompt_length: number;
    system_prompt_length: number;
}

export type AssembledGenerateResponse = GenerateOutcome & { _debug?: AssembledDebugMeta };

/** GET text/tasks/:taskId (SMR TaskResponse) — also the cancel response body. */
export interface SmrTask {
    task_id: string;
    status: string;
    provider: string;
    model: string;
    retry_count: number;
    max_retries: number;
    created_at: string;
    started_at?: string | null;
    completed_at?: string | null;
    error?: string | null;
    content?: string | null;
    usage?: SmrTokenUsage | null;
    total_chunks: number;
    total_tokens: number;
}

/** SSE frame on GET text/tasks/:taskId/stream (SMR StreamChunk; named events). */
export interface SmrStreamFrame {
    type: 'chunk' | 'reasoning' | 'meta' | 'done' | 'error' | 'usage';
    content?: string | null;
    data?: Record<string, unknown> | null;
}

// ─── Guardrails + NER tabs (verbatim upstream shapes) ───

export const GUARDRAIL_TYPES = ['content_safety', 'pii_detection', 'prompt_injection', 'comprehensive'] as const;
export type GuardrailType = (typeof GUARDRAIL_TYPES)[number];

/** Guardrail service `POST /api/guardrail/analyze` verdict (proxied verbatim). */
export interface GuardrailAnalysis {
    safe: boolean;
    issues: string[];
    confidence: number;
    processing_time_ms?: number;
    request_id?: string;
    timestamp?: string;
    error?: string | null;
}

/** NLP token-classification entity (proxied verbatim). */
export interface NerEntity {
    id?: string;
    text: string;
    normalized_text?: string;
    entity_type: string;
    confidence: number;
    position?: { start: number; end: number };
    model_version?: string | null;
}

/** NLP `POST /api/v1/classify/tokens` result (proxied verbatim). */
export interface NerResult {
    entities: NerEntity[];
    model_version: string;
}
