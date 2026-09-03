/**
 * turning NLP entity offsets into safe, renderable text segments.
 *
 * `LiveSummaryEntityDto` carries `start`/`end` character offsets into
 * `runningSummary` (`packages/applications/.../live-summary.dto.ts:32-36`). Splicing
 * markup on offsets is the operation that can corrupt a dose or a drug name if the
 * offsets are stale relative to the text, so this module VERIFIES every span against
 * the source and DROPS what does not match — it never re-anchors a span by searching
 * for its text, because the second occurrence of "5mg" is not the one the model meant.
 *
 * That is deliberately the same posture the harness applies to its own correction
 * proposals (`interpreter_consultation_propose_corrections._verified_proposals`:
 * "a proposal whose [start:end) does not equal its own `original` is DROPPED").
 *
 * Pure and framework-free so the safety property is testable without a component
 * (same convention as `features/workflow-studio/lib/schema-form.ts`).
 */

/** The subset of a live-summary entity this module needs. Offsets are optional on the wire. */
export interface EntityCandidate {
  text: string;
  type: string;
  confidence?: number;
  icd10?: string;
  start?: number;
  end?: number;
}

/** An entity whose offsets have been proven against the source text. */
export interface EntitySpan {
  start: number;
  end: number;
  text: string;
  type: string;
  confidence?: number;
  icd10?: string;
}

/** One run of text, either plain (`entity: null`) or covered by exactly one verified span. */
export interface HighlightSegment {
  text: string;
  entity: EntitySpan | null;
}

/**
 * Keep only the entities whose `[start, end)` slices the source into exactly their own
 * `text`, sorted by start, with any span overlapping an already-accepted one dropped
 * (nested `<mark>` elements are invalid, and an overlap means at least one offset is wrong).
 */
export function verifiedEntitySpans(text: string, entities: readonly EntityCandidate[]): EntitySpan[] {
  const candidates: EntitySpan[] = [];

  for (const entity of entities) {
    const { start, end } = entity;
    if (typeof start !== 'number' || typeof end !== 'number') continue;
    if (!Number.isInteger(start) || !Number.isInteger(end)) continue;
    if (start < 0 || end > text.length || end <= start) continue;
    // The verification that makes this safe: the offsets must reproduce the entity's
    // own text. A mismatch means the text moved under the offsets — drop it.
    if (text.slice(start, end) !== entity.text) continue;

    candidates.push({ start, end, text: entity.text, type: entity.type, confidence: entity.confidence, icd10: entity.icd10 });
  }

  candidates.sort((left, right) => left.start - right.start || left.end - right.end);

  const accepted: EntitySpan[] = [];
  let cursor = 0;
  for (const span of candidates) {
    if (span.start < cursor) continue;
    accepted.push(span);
    cursor = span.end;
  }
  return accepted;
}

/**
 * Split `text` into alternating plain/entity segments. Segments always reassemble to the
 * source exactly — the invariant the tests pin, because a renderer that loses a character
 * of clinical text is worse than one that highlights nothing.
 */
export function buildEntityHighlights(text: string, spans: readonly EntitySpan[]): HighlightSegment[] {
  if (spans.length === 0) return [{ text, entity: null }];

  const segments: HighlightSegment[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.start > cursor) segments.push({ text: text.slice(cursor, span.start), entity: null });
    segments.push({ text: text.slice(span.start, span.end), entity: span });
    cursor = span.end;
  }
  if (cursor < text.length) segments.push({ text: text.slice(cursor), entity: null });
  return segments;
}
