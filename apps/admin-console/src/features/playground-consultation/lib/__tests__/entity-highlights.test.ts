/**
 * TASK-797 W3 — "highlight detected details/entities/important information".
 *
 * `LiveSummaryEntityDto` has carried `start`/`end` character offsets into
 * `runningSummary` since it was written; the console's local mirror dropped them,
 * so entities could only ever be listed as chips, never marked in the text.
 *
 * Splicing markup into clinical text on offsets is exactly the operation that can
 * corrupt a dose or a drug name if the offsets are stale, so every span is VERIFIED
 * against the source before it is used — the same posture the harness applies to its
 * own correction proposals (`_verified_proposals`: a proposal whose [start:end) does
 * not equal its own `original` is DROPPED). A span that does not match is discarded,
 * never approximated.
 */
import { describe, expect, it } from 'vitest';
import { buildEntityHighlights, verifiedEntitySpans } from '../entity-highlights';

const TEXT = 'Patient reports chest pain. Started metformin 500mg twice daily.';

describe('verifiedEntitySpans', () => {
  it('keeps a span whose offsets slice out exactly its own text', () => {
    const spans = verifiedEntitySpans(TEXT, [{ text: 'chest pain', type: 'CONDITION', start: 16, end: 26 }]);
    expect(spans).toHaveLength(1);
    expect(spans[0]).toMatchObject({ start: 16, end: 26, text: 'chest pain', type: 'CONDITION' });
  });

  it('DROPS a span whose offsets do not slice out its own text — never re-anchors it', () => {
    // Off by two: [14,24) is "s chest pa", not "chest pain".
    expect(verifiedEntitySpans(TEXT, [{ text: 'chest pain', type: 'CONDITION', start: 14, end: 24 }])).toEqual([]);
  });

  it('drops entities with no offsets at all rather than guessing them by search', () => {
    expect(verifiedEntitySpans(TEXT, [{ text: 'metformin', type: 'MEDICATION' }])).toEqual([]);
  });

  it('drops out-of-range, inverted and empty spans', () => {
    expect(
      verifiedEntitySpans(TEXT, [
        { text: 'x', type: 'X', start: -1, end: 3 },
        { text: 'x', type: 'X', start: 5, end: 5 },
        { text: 'x', type: 'X', start: 9, end: 4 },
        { text: 'x', type: 'X', start: 0, end: 9999 },
      ]),
    ).toEqual([]);
  });

  it('sorts by start and drops a later span that overlaps an accepted one', () => {
    const spans = verifiedEntitySpans(TEXT, [
      { text: 'metformin 500mg', type: 'MEDICATION', start: 36, end: 51 },
      { text: 'chest pain', type: 'CONDITION', start: 16, end: 26 },
      // Overlaps the medication span — a nested <mark> would produce invalid nesting.
      { text: '500mg', type: 'DOSAGE', start: 46, end: 51 },
    ]);
    expect(spans.map((span) => span.start)).toEqual([16, 36]);
  });

  it('carries icd10 and confidence through untouched', () => {
    const spans = verifiedEntitySpans(TEXT, [{ text: 'chest pain', type: 'CONDITION', start: 16, end: 26, icd10: 'R07.9', confidence: 0.91 }]);
    expect(spans[0].icd10).toBe('R07.9');
    expect(spans[0].confidence).toBe(0.91);
  });
});

describe('buildEntityHighlights', () => {
  it('splits the text into plain and entity segments that reassemble to the original', () => {
    const spans = verifiedEntitySpans(TEXT, [
      { text: 'chest pain', type: 'CONDITION', start: 16, end: 26 },
      { text: 'metformin', type: 'MEDICATION', start: 36, end: 45 },
    ]);
    const segments = buildEntityHighlights(TEXT, spans);

    expect(segments.map((segment) => segment.text).join('')).toBe(TEXT);
    expect(segments.filter((segment) => segment.entity !== null).map((segment) => segment.text)).toEqual(['chest pain', 'metformin']);
  });

  it('returns one plain segment when there is nothing to mark', () => {
    expect(buildEntityHighlights(TEXT, [])).toEqual([{ text: TEXT, entity: null }]);
  });

  it('handles a span at the very start and one at the very end without emitting empty segments', () => {
    const text = 'aspirin daily for angina';
    const spans = verifiedEntitySpans(text, [
      { text: 'aspirin', type: 'MEDICATION', start: 0, end: 7 },
      { text: 'angina', type: 'CONDITION', start: 18, end: 24 },
    ]);
    const segments = buildEntityHighlights(text, spans);

    expect(segments.every((segment) => segment.text.length > 0)).toBe(true);
    expect(segments.map((segment) => segment.text).join('')).toBe(text);
  });

  it('never loses or duplicates a character for any accepted span set', () => {
    const spans = verifiedEntitySpans(TEXT, [
      { text: 'chest pain', type: 'CONDITION', start: 16, end: 26 },
      { text: 'metformin 500mg', type: 'MEDICATION', start: 36, end: 51 },
      { text: 'twice daily', type: 'FREQUENCY', start: 52, end: 63 },
    ]);
    expect(buildEntityHighlights(TEXT, spans).map((segment) => segment.text).join('')).toBe(TEXT);
  });
});
