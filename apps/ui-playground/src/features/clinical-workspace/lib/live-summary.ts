/**
 * Live-summary helpers (TASK-330 P3, WS4).
 *
 * Pure transforms used by `LiveSummaryPanel` and `useLiveSummaryStream`:
 *   - `buildEntityHighlights` slices the running summary into contiguous
 *     segments so recognised medical entities can be highlighted inline using
 *     their `start`/`end` character offsets.
 *   - `reduceLiveSummaryMessage` classifies a raw SSE `message` payload into a
 *     summary event, the terminal (closed) event, a heartbeat, or invalid.
 *
 * No `@arcaai/vox` runtime dependency — only local types — so these are
 * directly unit-testable under the stubbed-SDK vitest config.
 */
import type { LiveSummaryEntity, LiveSummaryEvent, LiveSummarySection } from '../types';

/** Canonical SOAP section order for the structured live summary (TASK-339 FU1). */
export const SOAP_SECTION_TITLES = ['Subjective', 'Objective', 'Assessment', 'Plan'] as const;
const SOAP_TITLE_SET = new Set<string>(SOAP_SECTION_TITLES);

/** A contiguous run of the running summary, optionally tagged with an entity. */
export interface LiveSummarySegment {
  text: string;
  entity: LiveSummaryEntity | null;
}

/** A SOAP section ready to render: its label, body, and inline-highlight segments. */
export interface SoapSectionView {
  title: string;
  content: string;
  /** False when the section has no content yet (render an empty/placeholder slot). */
  populated: boolean;
  segments: LiveSummarySegment[];
}

/**
 * Split `text` into ordered segments, wrapping each valid entity span. Invalid
 * spans (out of range, empty, inverted) and spans overlapping an already-placed
 * entity are skipped so the output always reconstructs `text` exactly.
 */
export function buildEntityHighlights(text: string, entities: LiveSummaryEntity[]): LiveSummarySegment[] {
  if (!text) return [];

  const valid = [...entities]
    .filter((e) => Number.isInteger(e.start) && Number.isInteger(e.end) && e.start >= 0 && e.end <= text.length && e.start < e.end)
    .sort((a, b) => a.start - b.start || b.end - a.end);

  const segments: LiveSummarySegment[] = [];
  let cursor = 0;

  for (const entity of valid) {
    // Drop entities that overlap a span we've already emitted.
    if (entity.start < cursor) continue;

    if (entity.start > cursor) {
      segments.push({ text: text.slice(cursor, entity.start), entity: null });
    }
    segments.push({ text: text.slice(entity.start, entity.end), entity });
    cursor = entity.end;
  }

  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor), entity: null });
  }

  return segments;
}

/**
 * Build the per-section render model for the structured live summary.
 *
 * Entities carry `start`/`end` offsets into the flat `runningSummary` (the text
 * the server ran NER over). Because `runningSummary` is the concatenation of the
 * section bodies, we locate each section's window inside it and re-base the
 * entities that fall within into section-local offsets — so each section is
 * highlighted independently and an entity can never bleed across a boundary.
 *
 * When the event is a structured SOAP note we always emit the four canonical
 * slots in order (unpopulated ones render as empty placeholders). Otherwise the
 * given sections (e.g. the single "Running Summary" fallback) pass through.
 */
export function buildSoapSectionViews(runningSummary: string, sections: LiveSummarySection[], entities: LiveSummaryEntity[]): SoapSectionView[] {
  const isSoap = sections.some((s) => SOAP_TITLE_SET.has(s.title));
  const ordered: LiveSummarySection[] = isSoap
    ? SOAP_SECTION_TITLES.map((title) => sections.find((s) => s.title === title) ?? { title, content: '' })
    : sections;

  let cursor = 0;
  return ordered.map((section) => {
    const content = section.content ?? '';
    if (!content.trim()) {
      return { title: section.title, content: '', populated: false, segments: [] };
    }

    let windowStart = runningSummary.indexOf(content, cursor);
    if (windowStart < 0) windowStart = runningSummary.indexOf(content);
    if (windowStart < 0) {
      // Content not locatable in runningSummary — render it plainly (no offsets to trust).
      return { title: section.title, content, populated: true, segments: [{ text: content, entity: null }] };
    }
    const windowEnd = windowStart + content.length;
    cursor = windowEnd;

    const localEntities = entities
      .filter((e) => Number.isInteger(e.start) && Number.isInteger(e.end) && e.start >= windowStart && e.end <= windowEnd && e.start < e.end)
      .map((e) => ({ ...e, start: e.start - windowStart, end: e.end - windowStart }));

    return { title: section.title, content, populated: true, segments: buildEntityHighlights(content, localEntities) };
  });
}

/** Classification of a raw SSE `message` payload. */
export type LiveSummaryMessage =
  { kind: 'event'; event: LiveSummaryEvent } | { kind: 'closed'; event: LiveSummaryEvent } | { kind: 'heartbeat' } | { kind: 'invalid' };

function isHeartbeat(value: Record<string, unknown>): boolean {
  if (value.type === 'heartbeat' || value.heartbeat === true) return true;
  // A bare {} or a payload with no summary content is treated as a keep-alive.
  const hasContent =
    typeof value.runningSummary === 'string' ||
    Array.isArray(value.sections) ||
    Array.isArray(value.entities) ||
    typeof value.consultationId === 'string';
  return !hasContent && value.closed !== true;
}

/** Coerce a parsed payload into a well-formed `LiveSummaryEvent`. */
export function normalizeLiveSummaryEvent(raw: Record<string, unknown>): LiveSummaryEvent {
  const entities = Array.isArray(raw.entities)
    ? (raw.entities as unknown[]).filter((e): e is LiveSummaryEntity => {
        const ent = e as Partial<LiveSummaryEntity>;
        return typeof ent?.text === 'string' && typeof ent?.start === 'number' && typeof ent?.end === 'number';
      })
    : [];
  const sections = Array.isArray(raw.sections)
    ? (raw.sections as unknown[])
        .map((s) => s as { title?: unknown; content?: unknown })
        .filter((s) => typeof s.title === 'string')
        .map((s) => ({ title: String(s.title), content: typeof s.content === 'string' ? s.content : '' }))
    : [];

  return {
    consultationId: typeof raw.consultationId === 'string' ? raw.consultationId : '',
    runningSummary: typeof raw.runningSummary === 'string' ? raw.runningSummary : '',
    sections,
    entities,
    lastSegmentId: typeof raw.lastSegmentId === 'string' ? raw.lastSegmentId : undefined,
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : new Date().toISOString(),
    closed: raw.closed === true,
  };
}

/**
 * Classify a raw SSE data string. Heartbeats and parse failures never throw —
 * the stream hook simply ignores them.
 */
export function reduceLiveSummaryMessage(rawData: string): LiveSummaryMessage {
  const trimmed = rawData?.trim();
  if (!trimmed) return { kind: 'heartbeat' };

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch {
    return { kind: 'invalid' };
  }

  if (typeof parsed !== 'object' || parsed === null) {
    return { kind: 'invalid' };
  }

  const value = parsed as Record<string, unknown>;
  if (isHeartbeat(value)) return { kind: 'heartbeat' };

  const event = normalizeLiveSummaryEvent(value);
  return event.closed ? { kind: 'closed', event } : { kind: 'event', event };
}
