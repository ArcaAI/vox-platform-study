/**
 * Section parsing for the live running summary, driven by a COMPILED DOCUMENT
 * TEMPLATE rather than by a hardcoded list of headings.
 *
 * ## What this module replaces, and why it had to be replaced
 *
 * This is the rewrite of `soap-parser.ts`. That module excluded custom document
 * shapes in FIVE structural places — not by omission, but by construction:
 *
 * | Old | Why it was a wall |
 * |---|---|
 * | `SOAP_SECTION_TITLES` | four titles as a `readonly` tuple, and the module's own `SoapTitle` type derived from it |
 * | `LIVE_SOAP_RESPONSE_FORMAT` | a frozen `json_schema` literal naming the same four keys |
 * | `parseSoapJson` | claimed the JSON path only if a SOAP key was present |
 * | `parseSoapSections` | emitted exactly the four titles, in that order |
 * | `buildRunningSummary` | (already shape-agnostic — the one piece that survives unchanged) |
 *
 * A tenant wanting a discharge summary had nowhere to put it. Now every one of
 * those decisions reads off `CompiledDocumentTemplate.sectionKeys` and
 * `checklist`, so SOAP is one row in the catalog and nothing in this file knows
 * its name.
 *
 * ## D-21 — `null` means "not discussed", and it is not the same as `""`
 *
 * The compiled schema makes every optional section NULLABLE, so a model can
 * record that a section never came up. This parser preserves that distinction
 * all the way to the section list: a `null` section becomes `content: ''` with
 * `notDiscussed: true`, where an empty STRING becomes `content: ''` with
 * `notDiscussed: false`. Collapsing the two would throw away the only evidence
 * that the model declined to invent something, which is the entire point of
 * making the field nullable in the first place.
 */
import type { CompiledDocumentTemplate } from '../../document-template/document-template-compiler';
import type { LiveSummarySectionDto } from './dto';

/** Title used when the TEXT output cannot be parsed into the template's sections. */
export const RUNNING_SUMMARY_TITLE = 'Running Summary';

/** A parsed section, plus the D-21 signal the DTO does not carry. */
export interface ParsedSection extends LiveSummarySectionDto {
  /** True when the model explicitly emitted `null` for this section. */
  notDiscussed?: boolean;
}

/** Escape a section title for use inside a RegExp alternation. */
function escapeForRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

interface HeaderMatchers {
  withColon: RegExp;
  standalone: RegExp;
  /** Lower-cased title (and key) → the canonical title to emit. */
  titleByKeyword: Map<string, string>;
}

/**
 * Build the prose header matchers for one template.
 *
 * Both the section TITLE ("Follow-up") and the section KEY ("follow_up") are
 * accepted, because a model handed a JSON-shaped instruction that then falls
 * back to prose tends to emit whichever of the two the instruction named last.
 * Accepting both costs nothing and is the difference between a parsed note and
 * a wall of unstructured text.
 */
function matchersFor(compiled: CompiledDocumentTemplate): HeaderMatchers {
  const titleByKeyword = new Map<string, string>();
  const alternatives: string[] = [];

  for (const entry of compiled.checklist) {
    titleByKeyword.set(entry.title.toLowerCase(), entry.title);
    titleByKeyword.set(entry.key.toLowerCase(), entry.title);
    alternatives.push(escapeForRegExp(entry.title), escapeForRegExp(entry.key));
  }

  const alternation = alternatives.join('|');
  return {
    // Header with a colon; inline content after the colon is captured:
    // "Subjective: ...", "**Objective:** ...".
    withColon: new RegExp(`^\\s*(?:#{1,6}\\s*|[-*>]\\s*)*(?:\\*\\*|__)?\\s*(${alternation})\\s*(?:\\*\\*|__)?\\s*:\\s*(.*)$`, 'i'),
    // Standalone header line: "## Subjective", "**Plan**", "Assessment".
    standalone: new RegExp(`^\\s*(?:#{1,6}\\s*|[-*>]\\s*)*(?:\\*\\*|__)?\\s*(${alternation})\\s*(?:\\*\\*|__)?\\s*$`, 'i'),
    titleByKeyword,
  };
}

/** Drop leading/trailing markdown emphasis (e.g. a trailing `**` from `Objective:** ...`). */
function stripEmphasis(value: string): string {
  return value.replace(/^[*_\s]+/, '').replace(/[*_\s]+$/, '');
}

function matchHeader(line: string, matchers: HeaderMatchers): { title: string; inline: string } | null {
  const withColon = line.match(matchers.withColon);
  if (withColon) {
    const title = matchers.titleByKeyword.get(withColon[1].toLowerCase());
    if (title) return { title, inline: stripEmphasis((withColon[2] ?? '').trim()) };
  }
  const standalone = line.match(matchers.standalone);
  if (standalone) {
    const title = matchers.titleByKeyword.get(standalone[1].toLowerCase());
    if (title) return { title, inline: '' };
  }
  return null;
}

/**
 * Parse TEXT running-note text into the template's ordered sections. Requires
 * at least two recognisable headers to be considered structured; otherwise
 * returns a single "Running Summary" section with the whole text.
 *
 * The two-header floor is unchanged from the SOAP parser and is deliberate: one
 * matched header is far more likely to be a sentence that happens to start with
 * a section word than a genuinely structured note.
 */
export function parseDocumentSections(raw: string, compiled: CompiledDocumentTemplate): ParsedSection[] {
  const text = (raw ?? '').trim();
  if (!text) return [];

  const matchers = matchersFor(compiled);
  const collected = new Map<string, string[]>();
  let current: string | null = null;

  for (const line of text.split(/\r?\n/)) {
    const header = matchHeader(line, matchers);
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

  return compiled.checklist.map((entry) => ({
    title: entry.title,
    content: (collected.get(entry.title) ?? []).join('\n').trim(),
  }));
}

/** Strip a leading/trailing markdown code fence (```/```json) that models often add. */
function stripCodeFence(text: string): string {
  const fenced = text.match(/^```(?:json)?\s*\n?([\s\S]*?)\n?```$/i);
  return fenced ? fenced[1].trim() : text;
}

/**
 * Deterministically parse a document **JSON** payload (from `response_format:
 * json_schema`) into the template's ordered sections. Returns `null` when the
 * input is not a shaped JSON object so the caller can fall back to the prose
 * parser. Lenient on missing keys and key casing; requires at least one
 * recognised section key to claim the JSON path.
 */
export function parseDocumentJson(raw: string, compiled: CompiledDocumentTemplate): ParsedSection[] | null {
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

  const hasAnySectionKey = compiled.checklist.some((entry) => byLowerKey.has(entry.key.toLowerCase()) || byLowerKey.has(entry.title.toLowerCase()));
  if (!hasAnySectionKey) return null;

  return compiled.checklist.map((entry) => {
    const sourceKey = byLowerKey.get(entry.key.toLowerCase()) ?? byLowerKey.get(entry.title.toLowerCase());
    const value = sourceKey ? record[sourceKey] : undefined;

    // D-21: an EXPLICIT null is the model saying "this never came up". That is
    // a different, and clinically better, fact than an empty string, and it is
    // the outcome the nullable compiled schema exists to make available.
    if (value === null) {
      return { title: entry.title, content: '', notDiscussed: true };
    }
    if (typeof value === 'string') {
      return { title: entry.title, content: value.trim() };
    }
    // A STRUCTURED section arrives as an object; render it canonically rather
    // than dropping it, so the running summary still carries the content.
    if (value !== undefined && typeof value === 'object') {
      return { title: entry.title, content: JSON.stringify(value, null, 2) };
    }
    return { title: entry.title, content: '' };
  });
}

/**
 * Reconstitute the flat running summary from the parsed sections. This is the
 * canonical text the NLP entity offsets are computed against, so the frontend
 * can map each global offset back into the section that renders it.
 *
 * Unchanged from the SOAP parser: it was already shape-agnostic.
 */
export function buildRunningSummary(sections: LiveSummarySectionDto[]): string {
  return sections
    .map((section) => section.content.trim())
    .filter((content) => content.length > 0)
    .join('\n\n');
}
