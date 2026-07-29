/**
 * highlight-anchoring (TASK-344 Workstream B) — pure W3C dual-selector logic.
 *
 * Covers anchor computation, re-attachment tiers (position → quote → fuzzy →
 * orphaned), the never-throw contract, and render-segment building.
 */
import { describe, it, expect, afterEach, beforeEach } from 'vitest';
import {
  ANCHOR_CONTEXT_LEN,
  buildHighlightSegments,
  computeAnchor,
  computeAnchorFromSelection,
  reattachAnchor,
  resolveHighlights,
  type HighlightAnchor,
  type StoredHighlight,
} from '../highlight-anchoring';

describe('computeAnchor', () => {
  const text = 'The patient reports severe chest pain radiating to the left arm.';

  it('captures exact + position for a valid span', () => {
    const start = text.indexOf('chest pain');
    const end = start + 'chest pain'.length;
    const anchor = computeAnchor(text, start, end);
    expect(anchor).not.toBeNull();
    expect(anchor!.quote.exact).toBe('chest pain');
    expect(anchor!.position).toEqual({ start, end });
  });

  it('captures bounded prefix/suffix context', () => {
    const start = text.indexOf('chest');
    const end = start + 'chest'.length;
    const anchor = computeAnchor(text, start, end)!;
    expect(anchor.quote.prefix!.length).toBeLessThanOrEqual(ANCHOR_CONTEXT_LEN);
    expect(anchor.quote.suffix!.length).toBeLessThanOrEqual(ANCHOR_CONTEXT_LEN);
    expect(text.endsWith(anchor.quote.suffix!) || anchor.quote.suffix!.length === ANCHOR_CONTEXT_LEN).toBe(true);
    expect(anchor.quote.prefix!.endsWith('reports severe ')).toBe(true);
  });

  it('returns null for empty / zero-length / inverted / out-of-range spans (never throws)', () => {
    expect(computeAnchor(text, 5, 5)).toBeNull();
    expect(computeAnchor(text, 10, 4)).toBeNull();
    expect(computeAnchor(text, -1, 4)).toBeNull();
    expect(computeAnchor(text, 0, text.length + 5)).toBeNull();
    expect(computeAnchor('', 0, 0)).toBeNull();
    expect(computeAnchor(null as never, 0, 1)).toBeNull();
  });
});

describe('reattachAnchor', () => {
  it('uses the position tier when offsets still match exactly', () => {
    const text = 'alpha beta gamma';
    const anchor = computeAnchor(text, 6, 10)!; // "beta"
    const res = reattachAnchor(text, anchor);
    expect(res.status).toBe('position');
    if (res.status !== 'orphaned') expect(text.slice(res.position.start, res.position.end)).toBe('beta');
  });

  it('falls back to the quote tier and disambiguates duplicates by context', () => {
    const original = 'chest pain and back pain';
    // Anchor the SECOND "pain" (after "back ").
    const start = original.lastIndexOf('pain');
    const anchor = computeAnchor(original, start, start + 4)!;
    // Shift offsets by prepending text so the position tier misses.
    const shifted = 'NOTE: chest pain and back pain';
    const res = reattachAnchor(shifted, anchor);
    expect(res.status).toBe('quote');
    if (res.status !== 'orphaned') {
      expect(shifted.slice(res.position.start, res.position.end)).toBe('pain');
      expect(res.position.start).toBe(shifted.lastIndexOf('pain'));
    }
  });

  it('uses the fuzzy tier for an ambiguous match with no usable context', () => {
    const anchor: HighlightAnchor = {
      quote: { exact: 'pain' }, // no prefix/suffix
      position: { start: 999, end: 1003 }, // invalid → position tier misses
    };
    const text = 'pain ... pain ... pain';
    const res = reattachAnchor(text, anchor);
    expect(res.status).toBe('fuzzy');
    if (res.status !== 'orphaned') expect(res.position).toEqual({ start: 0, end: 4 });
  });

  it('reports orphaned when the exact text is gone', () => {
    const anchor = computeAnchor('the quick brown fox', 4, 9)!; // "quick"
    expect(reattachAnchor('a totally different transcript', anchor).status).toBe('orphaned');
  });

  it('never throws on malformed input', () => {
    expect(() => reattachAnchor('', { quote: { exact: '' }, position: { start: 0, end: 0 } })).not.toThrow();
    expect(reattachAnchor('', null as never).status).toBe('orphaned');
    expect(reattachAnchor(null as never, { quote: { exact: 'x' }, position: { start: 0, end: 1 } }).status).toBe('orphaned');
  });
});

describe('buildHighlightSegments', () => {
  it('wraps highlighted spans and reconstructs the text exactly', () => {
    const text = 'abcdefgh';
    const segments = buildHighlightSegments(text, [{ id: '1', position: { start: 2, end: 4 } }]);
    expect(segments.map((s) => s.text).join('')).toBe(text);
    const marked = segments.filter((s) => s.highlight);
    expect(marked).toHaveLength(1);
    expect(marked[0].text).toBe('cd');
    expect(marked[0].highlight!.id).toBe('1');
  });

  it('skips overlapping and out-of-range highlights', () => {
    const text = 'abcdefgh';
    const segments = buildHighlightSegments(text, [
      { id: '1', position: { start: 2, end: 4 } },
      { id: '2', position: { start: 3, end: 5 } }, // overlaps #1 → skipped
      { id: '3', position: { start: 5, end: 99 } }, // out of range → skipped
    ]);
    expect(segments.map((s) => s.text).join('')).toBe(text);
    expect(segments.filter((s) => s.highlight).map((s) => s.highlight!.id)).toEqual(['1']);
  });

  it('returns [] for empty text', () => {
    expect(buildHighlightSegments('', [{ id: '1', position: { start: 0, end: 1 } }])).toEqual([]);
  });
});

describe('resolveHighlights', () => {
  const text = 'Patient denies fever but reports a persistent cough.';
  const make = (over: Partial<StoredHighlight>): StoredHighlight => {
    const start = text.indexOf('cough');
    return { id: 'h1', exact: 'cough', startOffset: start, endOffset: start + 'cough'.length, ...over };
  };

  it('re-anchors stored highlights to the current text and reports the match tier', () => {
    const resolved = resolveHighlights(text, [make({ color: '#0ea5e9', label: 'symptom' })]);
    expect(resolved).toHaveLength(1);
    expect(text.slice(resolved[0].position.start, resolved[0].position.end)).toBe('cough');
    expect(resolved[0].match).toBe('position');
    expect(resolved[0].color).toBe('#0ea5e9');
    expect(resolved[0].label).toBe('symptom');
  });

  it('drops orphaned highlights whose exact text no longer exists', () => {
    const orphan = make({ id: 'gone', exact: 'myocardial infarction', startOffset: 5, endOffset: 26 });
    const resolved = resolveHighlights(text, [orphan]);
    expect(resolved).toEqual([]);
  });

  it('recovers via the quote tier when offsets drift', () => {
    const start = text.indexOf('cough');
    const drifted: StoredHighlight = {
      id: 'h2',
      exact: 'cough',
      prefix: 'persistent ',
      suffix: '.',
      startOffset: start + 100,
      endOffset: start + 105,
    };
    const resolved = resolveHighlights(text, [drifted]);
    expect(resolved).toHaveLength(1);
    expect(text.slice(resolved[0].position.start, resolved[0].position.end)).toBe('cough');
    expect(resolved[0].match).toBe('quote');
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// DOM selection → anchor. jsdom's Range.toString is partial, so the offset probe
// (`offsetOfPoint` measures `range.toString().length` from the container start
// to a DOM point) is made deterministic by stubbing Range.prototype.toString for
// a single-text-node container: the internally-created range always ends at
// (textNode, charOffset), so the prefix length is just that offset.
// ─────────────────────────────────────────────────────────────────────────────
describe('computeAnchorFromSelection', () => {
  const TEXT = 'The patient reports severe chest pain radiating to the left arm.';
  let container: HTMLParagraphElement;
  const originalToString = Range.prototype.toString;

  beforeEach(() => {
    Range.prototype.toString = function (this: Range): string {
      return String(this.endContainer.textContent ?? '').slice(0, this.endOffset);
    };
    container = document.createElement('p');
    container.textContent = TEXT;
    document.body.appendChild(container);
  });

  afterEach(() => {
    Range.prototype.toString = originalToString;
    container.remove();
  });

  /** A minimal Selection over `[start, end)` of the container's single text node. */
  function selectionOver(start: number, end: number, opts: { collapsed?: boolean; rangeCount?: number } = {}): Selection {
    const textNode = container.firstChild as Text;
    const range = document.createRange();
    range.setStart(textNode, start);
    range.setEnd(textNode, end);
    return {
      rangeCount: opts.rangeCount ?? 1,
      isCollapsed: opts.collapsed ?? start === end,
      getRangeAt: () => range,
    } as unknown as Selection;
  }

  it('builds the exact + bounded prefix/suffix + char offsets from a DOM selection', () => {
    const start = TEXT.indexOf('chest pain');
    const end = start + 'chest pain'.length;

    const anchor = computeAnchorFromSelection(container, selectionOver(start, end))!;

    expect(anchor).not.toBeNull();
    expect(anchor.quote.exact).toBe('chest pain');
    expect(anchor.position).toEqual({ start, end });
    expect(anchor.quote.prefix).toBe(TEXT.slice(Math.max(0, start - ANCHOR_CONTEXT_LEN), start));
    expect(anchor.quote.prefix!.length).toBeLessThanOrEqual(ANCHOR_CONTEXT_LEN);
    expect(anchor.quote.suffix).toBe(TEXT.slice(end, end + ANCHOR_CONTEXT_LEN));
  });

  it('normalizes a range whose measured points are descending (defensive min/max)', () => {
    const start = TEXT.indexOf('severe');
    const end = start + 'severe'.length;
    const textNode = container.firstChild as Text;

    // A real DOM Range always self-orders, so feed a hand-built range with the
    // start/end points reversed to exercise the helper's defensive min/max.
    const reversed = { startContainer: textNode, startOffset: end, endContainer: textNode, endOffset: start } as unknown as Range;
    const selection = { rangeCount: 1, isCollapsed: false, getRangeAt: () => reversed } as unknown as Selection;

    const anchor = computeAnchorFromSelection(container, selection)!;

    expect(anchor.quote.exact).toBe('severe');
    expect(anchor.position).toEqual({ start, end });
  });

  it('returns null for collapsed / empty / no-range selections (never throws)', () => {
    const at = TEXT.indexOf('patient');
    expect(computeAnchorFromSelection(container, selectionOver(at, at, { collapsed: true }))).toBeNull();
    expect(computeAnchorFromSelection(container, selectionOver(at, at + 3, { rangeCount: 0 }))).toBeNull();
    expect(computeAnchorFromSelection(container, null)).toBeNull();
    expect(computeAnchorFromSelection(null, selectionOver(at, at + 3))).toBeNull();
  });

  it('returns null when the selection falls outside the container', () => {
    const outside = document.createElement('p');
    outside.textContent = 'some other surface entirely';
    document.body.appendChild(outside);
    const outsideText = outside.firstChild as Text;
    const range = document.createRange();
    range.setStart(outsideText, 0);
    range.setEnd(outsideText, 4);
    const selection = { rangeCount: 1, isCollapsed: false, getRangeAt: () => range } as unknown as Selection;

    expect(computeAnchorFromSelection(container, selection)).toBeNull();
    outside.remove();
  });
});
