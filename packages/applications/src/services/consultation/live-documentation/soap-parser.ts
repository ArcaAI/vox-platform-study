/**
 * SOAP section parsing for the live running summary.
 *
 * The realtime TEXT call now asks for a structured S/O/A/P running note. These
 * pure helpers turn that text into the four canonical sections (in order) and
 * reconstitute the flat `runningSummary` the NLP entity highlights are offset
 * against. If the model returns unstructured prose, we degrade gracefully to a
 * single "Running Summary" section instead of crashing.
 */
import type { LiveSummarySectionDto } from './dto';

/** Canonical section order for a SOAP note. */
export const SOAP_SECTION_TITLES = ['Subjective', 'Objective', 'Assessment', 'Plan'] as const;

/** Title used when the TEXT output cannot be parsed into SOAP sections. */
export const RUNNING_SUMMARY_TITLE = 'Running Summary';

type SoapTitle = (typeof SOAP_SECTION_TITLES)[number];

const TITLE_BY_KEYWORD: Record<string, SoapTitle> = {
  subjective: 'Subjective',
  objective: 'Objective',
  assessment: 'Assessment',
  plan: 'Plan',
};

/** Header with a colon (inline content after the colon is captured): "Subjective: ...", "**Objective:** ...". */
const HEADER_WITH_COLON = /^\s*(?:#{1,6}\s*|[-*>]\s*)*(?:\*\*|__)?\s*(subjective|objective|assessment|plan)\s*(?:\*\*|__)?\s*:\s*(.*)$/i;

/** Standalone header line: "## Subjective", "**Plan**", "Assessment". */
const HEADER_STANDALONE = /^\s*(?:#{1,6}\s*|[-*>]\s*)*(?:\*\*|__)?\s*(subjective|objective|assessment|plan)\s*(?:\*\*|__)?\s*$/i;

interface HeaderMatch {
  title: SoapTitle;
  inline: string;
}

/** Drop leading/trailing markdown emphasis (e.g. a trailing `**` from `Objective:** ...`). */
function stripEmphasis(value: string): string {
  return value.replace(/^[*_\s]+/, '').replace(/[*_\s]+$/, '');
}

function matchHeader(line: string): HeaderMatch | null {
  const withColon = line.match(HEADER_WITH_COLON);
  if (withColon) {
    return { title: TITLE_BY_KEYWORD[withColon[1].toLowerCase()], inline: stripEmphasis((withColon[2] ?? '').trim()) };
  }
  const standalone = line.match(HEADER_STANDALONE);
  if (standalone) {
    return { title: TITLE_BY_KEYWORD[standalone[1].toLowerCase()], inline: '' };
  }
  return null;
}

/**
 * Parse TEXT running-note text into the four ordered SOAP sections. Requires at
 * least two recognisable SOAP headers to be considered structured; otherwise
 * returns a single "Running Summary" section with the whole text.
 */
export function parseSoapSections(raw: string): LiveSummarySectionDto[] {
  const text = (raw ?? '').trim();
  if (!text) return [];

  const collected = new Map<SoapTitle, string[]>();
  let current: SoapTitle | null = null;

  for (const line of text.split(/\r?\n/)) {
    const header = matchHeader(line);
    if (header) {
      current = header.title;
      if (!collected.has(current)) collected.set(current, []);
      if (header.inline) collected.get(current)!.push(header.inline);
    } else if (current) {
      collected.get(current)!.push(line);
    }
  }

  if (collected.size < 2) {
    return [{ title: RUNNING_SUMMARY_TITLE, content: text }];
  }

  return SOAP_SECTION_TITLES.map((title) => ({
    title,
    content: (collected.get(title) ?? []).join('\n').trim(),
  }));
}

/**
 * SOAP `response_format` (json_schema) for the live TEXT call.
 *
 * Forwarded to `/api/v1/generate` so a json-schema-capable provider returns a
 * deterministic `{ subjective, objective, assessment, plan }` object instead of
 * free text. {@link parseSoapJson} parses that deterministically; if the
 * provider ignores it and returns prose, the caller falls back to the regex
 * {@link parseSoapSections}. Mirrors the harness/PromptAssembly responseFormat
 * shape (`{ type, json_schema, strict }`).
 */
export const LIVE_SOAP_RESPONSE_FORMAT = {
  type: 'json_schema' as const,
  strict: true,
  json_schema: {
    title: 'LiveSOAPNote',
    type: 'object',
    properties: {
      subjective: { type: 'string' },
      objective: { type: 'string' },
      assessment: { type: 'string' },
      plan: { type: 'string' },
    },
    required: ['subjective', 'objective', 'assessment', 'plan'],
  },
};

/** Strip a leading/trailing markdown code fence (```/```json) that models often add. */
function stripCodeFence(text: string): string {
  const fenced = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
  return fenced ? fenced[1].trim() : text;
}

/**
 * Deterministically parse a SOAP **JSON** payload (from `response_format:
 * json_schema`) into the four ordered sections. Returns `null` when the input
 * is not a SOAP-shaped JSON object so the caller can fall back to the regex
 * {@link parseSoapSections}. Lenient on missing keys (empty content) and key
 * casing; requires at least one recognised SOAP key to claim the JSON path.
 */
export function parseSoapJson(raw: string): LiveSummarySectionDto[] | null {
  const text = (raw ?? '').trim();
  if (!text) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(stripCodeFence(text));
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

  const record = parsed as Record<string, unknown>;
  const byLowerKey = new Map(Object.keys(record).map((key) => [key.toLowerCase(), key]));
  const read = (title: SoapTitle): string => {
    const sourceKey = byLowerKey.get(title.toLowerCase());
    const value = sourceKey ? record[sourceKey] : undefined;
    return typeof value === 'string' ? value.trim() : '';
  };

  const hasAnySoapKey = SOAP_SECTION_TITLES.some((title) => byLowerKey.has(title.toLowerCase()));
  if (!hasAnySoapKey) return null;

  return SOAP_SECTION_TITLES.map((title) => ({ title, content: read(title) }));
}

/**
 * Reconstitute the flat running summary from the parsed sections. This is the
 * canonical text the NLP entity offsets are computed against, so the frontend
 * can map each global offset back into the section that renders it.
 */
export function buildRunningSummary(sections: LiveSummarySectionDto[]): string {
  return sections
    .map((section) => section.content.trim())
    .filter((content) => content.length > 0)
    .join('\n\n');
}
