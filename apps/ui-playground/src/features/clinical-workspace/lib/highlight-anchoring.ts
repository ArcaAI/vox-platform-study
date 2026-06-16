/**
 * Manual-highlight anchoring (TASK-344 Workstream B, Phase 1).
 *
 * Pure W3C Web Annotation dual-selector logic for doctor-authored highlights on
 * the consultation's PERSISTED surfaces (post-stop transcript, case/work notes,
 * summary). Two selectors are stored per highlight:
 *   - TextQuoteSelector  : `exact` + ~32-char `prefix`/`suffix` (survives re-flow)
 *   - TextPositionSelector: `start`/`end` char offsets (precise but brittle)
 *
 * Re-attachment degrades gracefully: position → quote (context-disambiguated) →
 * fuzzy (first bare occurrence) → orphaned. Nothing here throws — an empty or
 * zero-length selection simply yields `null`, and an unanchorable highlight is
 * reported as `orphaned` rather than crashing the render.
 *
 * No `@arcaai/vox` / DOM-library imports in the core, so it is directly
 * unit-testable under the stubbed-SDK vitest config.
 */

/** Characters of surrounding context captured on each side of the quote. */
export const ANCHOR_CONTEXT_LEN = 32;

/** W3C TextQuoteSelector — the selected text plus bounded surrounding context. */
export interface TextQuoteSelector {
  exact: string;
  prefix?: string;
  suffix?: string;
}

/** W3C TextPositionSelector — character offsets into the surface's plain text. */
export interface TextPositionSelector {
  start: number;
  end: number;
}

/** A highlight anchor: both selectors, computed once at selection time. */
export interface HighlightAnchor {
  quote: TextQuoteSelector;
  position: TextPositionSelector;
}

/**
 * Build dual selectors from `fullText` and a `[start, end)` span.
 *
 * Returns `null` (never throws) for an empty/zero-length/inverted/out-of-range
 * span or a non-string text, so callers can wire it straight to a mouseup
 * handler without guarding.
 */
export function computeAnchor(fullText: string, start: number, end: number): HighlightAnchor | null {
  if (typeof fullText !== 'string') return null;
  if (!Number.isInteger(start) || !Number.isInteger(end)) return null;
  if (start < 0 || end > fullText.length || start >= end) return null;

  const exact = fullText.slice(start, end);
  if (exact.length === 0) return null;

  const prefix = fullText.slice(Math.max(0, start - ANCHOR_CONTEXT_LEN), start);
  const suffix = fullText.slice(end, Math.min(fullText.length, end + ANCHOR_CONTEXT_LEN));

  return {
    quote: { exact, prefix: prefix || undefined, suffix: suffix || undefined },
    position: { start, end },
  };
}

/** Outcome of a re-attachment attempt against (possibly changed) text. */
export type ReattachResult = { status: 'position' | 'quote' | 'fuzzy'; position: TextPositionSelector } | { status: 'orphaned' };

/**
 * Re-anchor `anchor` against `fullText`, degrading through three tiers:
 *  1. `position` — offsets still point at the exact text.
 *  2. `quote`    — exact text located; if duplicated, disambiguated by the side
 *                  whose surrounding text best matches the stored prefix/suffix,
 *                  or unambiguous because it occurs once.
 *  3. `fuzzy`    — exact text occurs multiple times with no usable context; the
 *                  first occurrence is returned (low confidence).
 * Otherwise `orphaned`. Never throws.
 */
export function reattachAnchor(fullText: string, anchor: HighlightAnchor | null | undefined): ReattachResult {
  if (typeof fullText !== 'string' || !anchor || !anchor.quote || typeof anchor.quote.exact !== 'string' || anchor.quote.exact.length === 0) {
    return { status: 'orphaned' };
  }

  const { exact, prefix = '', suffix = '' } = anchor.quote;
  const pos = anchor.position;

  // 1) Position tier — trust the offsets only if the exact text is still there.
  if (
    pos &&
    Number.isInteger(pos.start) &&
    Number.isInteger(pos.end) &&
    pos.start >= 0 &&
    pos.end <= fullText.length &&
    fullText.slice(pos.start, pos.end) === exact
  ) {
    return { status: 'position', position: { start: pos.start, end: pos.end } };
  }

  // 2/3) Quote / fuzzy tiers.
  const located = locateByQuote(fullText, exact, prefix, suffix);
  if (located) {
    return { status: located.contextMatched ? 'quote' : 'fuzzy', position: located.position };
  }

  return { status: 'orphaned' };
}

interface QuoteMatch {
  position: TextPositionSelector;
  /** True when the chosen occurrence is unambiguous or its context matched. */
  contextMatched: boolean;
}

function locateByQuote(fullText: string, exact: string, prefix: string, suffix: string): QuoteMatch | null {
  const occurrences = allIndexesOf(fullText, exact);
  if (occurrences.length === 0) return null;

  if (occurrences.length === 1) {
    const start = occurrences[0];
    return { position: { start, end: start + exact.length }, contextMatched: true };
  }

  let best = occurrences[0];
  let bestScore = -1;
  for (const start of occurrences) {
    const before = fullText.slice(Math.max(0, start - prefix.length), start);
    const after = fullText.slice(start + exact.length, start + exact.length + suffix.length);
    const score = commonSuffixLength(before, prefix) + commonPrefixLength(after, suffix);
    if (score > bestScore) {
      bestScore = score;
      best = start;
    }
  }

  return { position: { start: best, end: best + exact.length }, contextMatched: bestScore > 0 };
}

function allIndexesOf(haystack: string, needle: string): number[] {
  const out: number[] = [];
  let from = 0;
  for (;;) {
    const i = haystack.indexOf(needle, from);
    if (i < 0) break;
    out.push(i);
    from = i + 1;
  }
  return out;
}

function commonPrefixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let n = 0;
  while (n < max && a[n] === b[n]) n++;
  return n;
}

function commonSuffixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let n = 0;
  while (n < max && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
  return n;
}

// ─────────────────────────────────────────────────────────────────────────────
// Render-segment building (mirrors `buildEntityHighlights` so manual marks layer
// the same way AI-entity marks do, but are tagged distinctly for styling).
// ─────────────────────────────────────────────────────────────────────────────

/** A highlight resolved to a concrete position on the current surface text. */
export interface AnchoredHighlight {
  id: string;
  position: TextPositionSelector;
  color?: string | null;
  label?: string | null;
  note?: string | null;
}

/** A contiguous run of surface text, optionally carrying a manual highlight. */
export interface HighlightTextSegment {
  text: string;
  highlight: AnchoredHighlight | null;
}

/**
 * Split `text` into ordered segments, wrapping each valid highlight span.
 * Invalid spans (out of range, empty, inverted) and spans overlapping an
 * already-placed highlight are skipped, so the output always reconstructs
 * `text` exactly. First-wins on overlap (sorted by start, then widest).
 */
export function buildHighlightSegments(text: string, highlights: AnchoredHighlight[]): HighlightTextSegment[] {
  if (!text) return [];

  const valid = [...highlights]
    .filter(
      (h) =>
        h?.position &&
        Number.isInteger(h.position.start) &&
        Number.isInteger(h.position.end) &&
        h.position.start >= 0 &&
        h.position.end <= text.length &&
        h.position.start < h.position.end,
    )
    .sort((a, b) => a.position.start - b.position.start || b.position.end - a.position.end);

  const segments: HighlightTextSegment[] = [];
  let cursor = 0;

  for (const h of valid) {
    if (h.position.start < cursor) continue;
    if (h.position.start > cursor) {
      segments.push({ text: text.slice(cursor, h.position.start), highlight: null });
    }
    segments.push({ text: text.slice(h.position.start, h.position.end), highlight: h });
    cursor = h.position.end;
  }

  if (cursor < text.length) {
    segments.push({ text: text.slice(cursor), highlight: null });
  }

  return segments;
}

// ─────────────────────────────────────────────────────────────────────────────
// Stored-highlight resolution (re-anchor persisted highlights to live text).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * The persisted shape needed to re-anchor a highlight. Structurally compatible
 * with the API `WorkspaceHighlight` (the extra response fields are ignored).
 */
export interface StoredHighlight {
  id: string;
  exact: string;
  prefix?: string | null;
  suffix?: string | null;
  startOffset: number;
  endOffset: number;
  color?: string | null;
  label?: string | null;
  note?: string | null;
}

/** A stored highlight resolved to a concrete position, tagged with its tier. */
export interface ResolvedHighlight extends AnchoredHighlight {
  match: 'position' | 'quote' | 'fuzzy';
}

/**
 * Re-anchor each stored highlight against the current `text`, dropping any that
 * orphan (their exact text is gone). The returned highlights carry the re-attach
 * tier so the UI can flag low-confidence (fuzzy) marks if desired.
 */
export function resolveHighlights(text: string, stored: StoredHighlight[]): ResolvedHighlight[] {
  const resolved: ResolvedHighlight[] = [];
  for (const h of stored) {
    const res = reattachAnchor(text, {
      quote: { exact: h.exact, prefix: h.prefix ?? undefined, suffix: h.suffix ?? undefined },
      position: { start: h.startOffset, end: h.endOffset },
    });
    if (res.status === 'orphaned') continue;
    resolved.push({ id: h.id, position: res.position, color: h.color, label: h.label, note: h.note, match: res.status });
  }
  return resolved;
}

// ─────────────────────────────────────────────────────────────────────────────
// DOM helpers (used by the React surface; not exercised by the pure unit tests
// because jsdom's Range string support is partial — kept thin and defensive).
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Character offset of a DOM point (node, offset) within `container`'s text,
 * measured by the length of the range from the container start to that point.
 * Returns `null` if the point can't be measured.
 */
function offsetOfPoint(container: HTMLElement, node: Node, offset: number): number | null {
  try {
    const range = container.ownerDocument.createRange();
    range.selectNodeContents(container);
    range.setEnd(node, offset);
    return range.toString().length;
  } catch {
    return null;
  }
}

/**
 * Compute a dual-selector anchor from a live DOM `Selection` scoped to
 * `container`. Returns `null` for a collapsed/empty/out-of-container selection
 * (never throws), so it can be wired straight to an `onMouseUp` handler.
 */
export function computeAnchorFromSelection(container: HTMLElement | null, selection: Selection | null): HighlightAnchor | null {
  if (!container || !selection || selection.rangeCount === 0 || selection.isCollapsed) return null;

  const range = selection.getRangeAt(0);
  if (!container.contains(range.startContainer) || !container.contains(range.endContainer)) return null;

  const fullText = container.textContent ?? '';
  const a = offsetOfPoint(container, range.startContainer, range.startOffset);
  const b = offsetOfPoint(container, range.endContainer, range.endOffset);
  if (a == null || b == null) return null;

  const start = Math.min(a, b);
  const end = Math.max(a, b);
  return computeAnchor(fullText, start, end);
}
