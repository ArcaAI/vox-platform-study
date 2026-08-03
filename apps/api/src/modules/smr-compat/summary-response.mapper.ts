import { randomUUID } from 'node:crypto';
import type { PreSummaryResponse, StructuredPreSummary, SummaryResponse, TokenUsage } from './dto/summary.response';

const DEFAULT_PRE_SUMMARY_TITLE = 'Pre-Summary of Medical History';

export interface SummaryMappingMeta {
  sessionId: string;
  summaryId?: string;
  useEnhanced: boolean;
  latencyMs?: number | null;
  finishReason?: string;
  tokenUsage?: TokenUsage | null;
  temperature?: number | null;
  maxTokens?: number | null;
  language?: string;
  specialty?: string | null;
  encounterType?: string | null;
  /** Set only when enrichment was applied — echoed into metadata. */
  preSummaryText?: string | null;
  /** v1-parity display labels (TASK-560 item 4) — cosmetic, no logic consumes them. */
  llmProvider?: string | null;
  modelName?: string | null;
  parsingMethod?: string | null;
  /** The raw LLM content string (same text parsed into `summary`). */
  rawLlmContent?: string | null;
  createdAt: Date;
}

/**
 * Strip reasoning-model "thinking" blocks the model may prepend to its answer.
 * Reasoning models that do NOT expose a separate reasoning channel (many LM
 * Studio GGUFs, some local models) emit their chain-of-thought INLINE as
 * `<think>…</think>` (or `<thinking>…</thinking>`) before the JSON. Left in
 * place it makes `JSON.parse` fail and the ENTIRE summary is lost, so it is
 * removed defensively. (Providers that expose reasoning via a dedicated field —
 * Azure `reasoning_content`, Anthropic thinking blocks — never reach here with
 * inline tags; this only rescues the inline case.)
 */
function stripReasoningBlocks(raw: string): string {
  return raw.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '').trim();
}

/**
 * Strip markdown code fences the model may wrap JSON output in.
 * Handles ```json … ``` and bare ``` … ``` fences.
 */
function stripCodeFences(raw: string): string {
  const trimmed = raw.trim();
  const fenced = /^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i.exec(trimmed);
  return fenced ? fenced[1].trim() : trimmed;
}

/**
 * Extract the LAST brace-balanced `{ … }` object from a string. Reasoning
 * models put their prose (which may itself contain stray `{`/`}`) BEFORE the
 * JSON answer, so we scan BACKWARD from the final `}`, matching depth, and
 * return the span of the last balanced top-level object. Returns null when
 * there is no balanced object. (Brace counting ignores string contents, which
 * is good enough here — the answer is a machine-emitted object, and a false
 * match simply fails the subsequent JSON.parse and surfaces as an error.)
 */
function extractLastJsonObject(s: string): string | null {
  const end = s.lastIndexOf('}');
  if (end === -1) return null;
  let depth = 0;
  for (let i = end; i >= 0; i--) {
    const ch = s[i];
    if (ch === '}') depth++;
    else if (ch === '{') {
      depth--;
      if (depth === 0) return s.slice(i, end + 1);
    }
  }
  return null;
}

/**
 * Parse the LLM `content` string as a JSON object. Throws a descriptive error
 * (surfaced by the controller as a v1 `500 { detail: "... failed: <reason>" }`)
 * when the content is not a JSON object. Tolerates reasoning-model output that
 * wraps the JSON in thinking tags or prose: think-blocks are stripped, and on a
 * direct-parse failure the last brace-balanced `{ … }` span is extracted and
 * re-parsed (rescues a leading preamble, an unterminated `<think>`, or trailing
 * commentary — otherwise the entire summary is lost to a parse error).
 */
function parseSummaryContent(content: string): Record<string, unknown> {
  const cleaned = stripCodeFences(stripReasoningBlocks(content ?? ''));
  if (!cleaned) {
    throw new Error('empty LLM content');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (directErr) {
    const span = extractLastJsonObject(cleaned);
    if (span === null) {
      throw new Error(`LLM content was not valid JSON (${directErr instanceof Error ? directErr.message : String(directErr)})`);
    }
    try {
      parsed = JSON.parse(span);
    } catch (spanErr) {
      throw new Error(`LLM content was not valid JSON (${spanErr instanceof Error ? spanErr.message : String(spanErr)})`);
    }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('LLM content was not a JSON object');
  }
  return parsed as Record<string, unknown>;
}

/** Extract the enhanced-summary completeness score as v1 `confidence_score`, when present and numeric. */
function extractConfidenceScore(summary: Record<string, unknown>, useEnhanced: boolean): number | null {
  if (!useEnhanced) return null;
  const quality = summary.quality_metrics;
  if (quality && typeof quality === 'object') {
    const score = (quality as Record<string, unknown>).completeness_score;
    if (typeof score === 'number' && Number.isFinite(score)) return score;
  }
  return null;
}

/**
 * Wrap the LLM `content` (a summary JSON object) in the v1 `SummaryResponse`.
 * `processing_time_ms` is filled from SMR's `latency_ms`. Provider internals
 * (e.g. `raw_llm_content`) are NEVER echoed.
 */
export function mapGenerateToV1Summary(content: string, meta: SummaryMappingMeta): SummaryResponse {
  const summary = parseSummaryContent(content);

  return {
    summary_id: meta.summaryId ?? randomUUID(),
    session_id: meta.sessionId,
    summary,
    created_at: meta.createdAt.toISOString(),
    processing_time_ms: typeof meta.latencyMs === 'number' ? meta.latencyMs : null,
    token_usage: meta.tokenUsage ?? null,
    confidence_score: extractConfidenceScore(summary, meta.useEnhanced),
    metadata: {
      finish_reason: meta.finishReason,
      temperature: meta.temperature ?? null,
      max_tokens: meta.maxTokens ?? null,
      use_enhanced_format: meta.useEnhanced,
      language: meta.language,
      specialty: meta.specialty ?? null,
      encounter_type: meta.encounterType ?? null,
      // v1-parity display labels (TASK-560 item 4).
      llm_provider: meta.llmProvider ?? null,
      model_name: meta.modelName ?? null,
      parsing_method: meta.parsingMethod ?? null,
      raw_llm_content: meta.rawLlmContent ?? null,
      ...(meta.preSummaryText ? { pre_summary_text: meta.preSummaryText } : {}),
    },
  };
}

/**
 * The 5 canonical pre-summary section titles, IN ORDER, recognized verbatim by
 * v1 (`previous_visit_service.py:215-221`). Only these exact titles are treated
 * as section headers; the structured output always carries all five, in order.
 */
export const PRE_SUMMARY_DISPLAY_TITLES = [
  'Confirmed & Provisional Diagnoses',
  'Plan of Care (Latest Department Note)',
  'Investigations (Latest Department Note)',
  'Medications Prescribed (Latest Department Note)',
  'Diagnostics & Trends',
] as const;

const PRE_SUMMARY_NOT_AVAILABLE = 'Not available';

/**
 * v1 header normalization (`previous_visit_service.py:227-242`): strip a leading
 * `- ` bullet, surrounding `**…**`, and a trailing `:` (plus dangling `**`), to
 * compare a line against the canonical display titles.
 */
function normalizePreSummaryHeader(raw: string): string {
  let s = raw.trim();
  if (s.startsWith('- ')) s = s.slice(2);
  if (s.startsWith('**') && s.endsWith('**')) s = s.slice(2, -2);
  if (s.endsWith(':')) s = s.slice(0, -1);
  if (s.startsWith('**')) s = s.slice(2);
  if (s.endsWith('**')) s = s.slice(0, -2);
  return s.trim();
}

/** v1 item cleanup (`previous_visit_service.py:266-273`): drop the `- ` bullet and all `**`. */
function cleanPreSummaryItem(line: string): string {
  let s = line.trim();
  if (s.startsWith('- ')) s = s.slice(2);
  return s.replace(/\*\*/g, '').trim();
}

/**
 * Parse a v1 pre-summary markdown into the 5 canonical sections, IN ORDER,
 * filling any missing (or empty) section with a single `Not available` item.
 * Faithful port of `PreviousVisitService.generate_pre_summary`
 * (`previous_visit_service.py:214-294`). Never returns `null` — the 5-section
 * shape is a guarantee.
 */
export function parseSections(markdown: string): StructuredPreSummary {
  const displayTitles = PRE_SUMMARY_DISPLAY_TITLES as readonly string[];
  const collected = new Map<string, StructuredPreSummary['sections'][number]['items']>();
  let currentTitle: string | null = null;

  for (const rawLine of (markdown ?? '').split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;

    const normalized = normalizePreSummaryHeader(line);
    if (displayTitles.includes(normalized)) {
      currentTitle = normalized;
      if (!collected.has(normalized)) collected.set(normalized, []);
      continue;
    }

    if (currentTitle) {
      const cleaned = cleanPreSummaryItem(line);
      if (cleaned) collected.get(currentTitle)!.push({ text: cleaned });
    }
  }

  // Emit all 5 sections in canonical order; missing/empty → single Not available.
  const sections = displayTitles.map((title) => {
    const items = collected.get(title);
    return { title, items: items && items.length > 0 ? items : [{ text: PRE_SUMMARY_NOT_AVAILABLE }] };
  });

  return { title: DEFAULT_PRE_SUMMARY_TITLE, sections };
}

/**
 * Wrap the LLM `content` (markdown pre-summary) in the v1 `PreSummaryResponse`.
 * `pre_summary` carries the full markdown (the client's source of truth), with
 * v1's title prepended when absent (`previous_visit_service.py:212-213`);
 * `structured_data` always carries the 5 canonical sections in order.
 */
export function mapGenerateToV1PreSummary(content: string, createdAt: Date): PreSummaryResponse {
  let preSummary = (content ?? '').trim();
  if (!preSummary.startsWith(`**${DEFAULT_PRE_SUMMARY_TITLE}**`)) {
    preSummary = `**${DEFAULT_PRE_SUMMARY_TITLE}**\n\n${preSummary}`;
  }
  return {
    pre_summary: preSummary,
    structured_data: parseSections(preSummary),
    created_at: createdAt.toISOString(),
  };
}
