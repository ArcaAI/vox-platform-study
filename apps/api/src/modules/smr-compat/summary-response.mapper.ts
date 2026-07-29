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
  createdAt: Date;
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
 * Parse the LLM `content` string as a JSON object. Throws a descriptive error
 * (surfaced by the controller as a v1 `500 { detail: "... failed: <reason>" }`)
 * when the content is not a JSON object.
 */
function parseSummaryContent(content: string): Record<string, unknown> {
  const cleaned = stripCodeFences(content ?? '');
  if (!cleaned) {
    throw new Error('empty LLM content');
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned);
  } catch (err) {
    throw new Error(`LLM content was not valid JSON (${err instanceof Error ? err.message : String(err)})`);
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
      ...(meta.preSummaryText ? { pre_summary_text: meta.preSummaryText } : {}),
    },
  };
}

/**
 * Parse markdown pre-summary text into `StructuredPreSummary` sections.
 * Recognizes `#`-style headings and bold-only heading lines (`**Heading**`),
 * collecting `-`/`*` bullet items beneath each. Returns `null` when no sections
 * are detected so callers can fall back to `{ title, sections: [] }`.
 */
export function parseSections(markdown: string): StructuredPreSummary | null {
  const lines = (markdown ?? '').split(/\r?\n/);
  const sections: StructuredPreSummary['sections'] = [];
  let title = DEFAULT_PRE_SUMMARY_TITLE;
  let current: StructuredPreSummary['sections'][number] | null = null;
  let sawTitle = false;

  const headingMatch = (line: string): string | null => {
    const trimmed = line.trim();
    const hash = /^#{1,6}\s+(.+?)\s*$/.exec(trimmed);
    if (hash) return hash[1].replace(/[*:]+$/g, '').trim();
    const bold = /^\*\*(.+?)\*\*:?\s*$/.exec(trimmed);
    if (bold) return bold[1].trim();
    return null;
  };

  const bulletMatch = (line: string): string | null => {
    const trimmed = line.trim();
    const bullet = /^[-*]\s+(.+?)\s*$/.exec(trimmed);
    if (bullet) return bullet[1].replace(/^\*\*(.+?)\*\*$/, '$1').trim();
    return null;
  };

  for (const line of lines) {
    const heading = headingMatch(line);
    if (heading) {
      // The first heading matching the canonical document title becomes the
      // title rather than a section.
      if (!sawTitle && heading.toLowerCase() === DEFAULT_PRE_SUMMARY_TITLE.toLowerCase()) {
        title = heading;
        sawTitle = true;
        continue;
      }
      sawTitle = true;
      current = { title: heading, items: [] };
      sections.push(current);
      continue;
    }
    const bullet = bulletMatch(line);
    if (bullet && current) {
      current.items.push({ text: bullet });
    }
  }

  if (sections.length === 0) return null;
  return { title, sections };
}

/**
 * Wrap the LLM `content` (markdown pre-summary) in the v1 `PreSummaryResponse`.
 * `pre_summary` carries the full markdown (the client's source of truth);
 * `structured_data.sections` is `[]` when no sections could be parsed.
 */
export function mapGenerateToV1PreSummary(content: string, createdAt: Date): PreSummaryResponse {
  const preSummary = (content ?? '').trim();
  const structured = parseSections(preSummary) ?? { title: DEFAULT_PRE_SUMMARY_TITLE, sections: [] };
  return {
    pre_summary: preSummary,
    structured_data: structured,
    created_at: createdAt.toISOString(),
  };
}
