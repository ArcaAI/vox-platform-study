/**
 * Click-to-source offset arithmetic.
 *
 * An off-by-one here silently marks the wrong words as the evidence for a
 * clinical claim — a trust failure, not a cosmetic one — so the edge cases are
 * pinned explicitly rather than left to the renderer.
 */
import { describe, it, expect } from 'vitest';
import { buildTranscriptHighlights, hasSegmentProvenance } from '../transcript-highlights';

const TEXT = 'Patient reports chest pain. No shortness of breath.';

/** Re-joining every run must reproduce the source exactly — no text lost or duplicated. */
const roundTrip = (segments: { text: string }[]) => segments.map((s) => s.text).join('');

describe('buildTranscriptHighlights (TASK-533 B5)', () => {
    it('splits a single span into before / highlighted / after', () => {
        const segments = buildTranscriptHighlights(TEXT, [{ startOffset: 16, endOffset: 26 }]);

        expect(segments.filter((s) => s.highlighted).map((s) => s.text)).toEqual(['chest pain']);
        expect(roundTrip(segments)).toBe(TEXT);
    });

    it('never loses or duplicates text, whatever the spans', () => {
        const segments = buildTranscriptHighlights(TEXT, [
            { startOffset: 31, endOffset: 40 },
            { startOffset: 0, endOffset: 7 },
        ]);

        expect(roundTrip(segments)).toBe(TEXT);
    });

    it('sorts out-of-order spans rather than emitting reversed runs', () => {
        const segments = buildTranscriptHighlights(TEXT, [
            { startOffset: 31, endOffset: 40 },
            { startOffset: 0, endOffset: 7 },
        ]);

        expect(segments[0].text).toBe('Patient');
        expect(segments[0].highlighted).toBe(true);
        expect(roundTrip(segments)).toBe(TEXT);
    });

    it('MERGES overlapping spans so no character is emitted twice', () => {
        // Two claims citing overlapping evidence is legitimate; nested marks
        // would double-emphasise the overlap.
        const segments = buildTranscriptHighlights(TEXT, [
            { startOffset: 8, endOffset: 20 },
            { startOffset: 16, endOffset: 26 },
        ]);

        expect(segments.filter((s) => s.highlighted)).toHaveLength(1);
        expect(segments.filter((s) => s.highlighted)[0].text).toBe('reports chest pain');
        expect(roundTrip(segments)).toBe(TEXT);
    });

    it('merges adjacent spans into one run', () => {
        const segments = buildTranscriptHighlights(TEXT, [
            { startOffset: 0, endOffset: 7 },
            { startOffset: 7, endOffset: 15 },
        ]);

        expect(segments.filter((s) => s.highlighted)).toHaveLength(1);
    });

    it('clamps a span that runs past the end of the transcript', () => {
        const segments = buildTranscriptHighlights(TEXT, [{ startOffset: 40, endOffset: 9999 }]);

        expect(roundTrip(segments)).toBe(TEXT);
        expect(segments.filter((s) => s.highlighted)[0].text).toBe(TEXT.slice(40));
    });

    it('drops degenerate spans instead of shifting the surrounding text', () => {
        for (const bad of [
            { startOffset: 20, endOffset: 10 }, // reversed
            { startOffset: 5, endOffset: 5 }, // zero-width
            { startOffset: -10, endOffset: -1 }, // out of range
            { startOffset: Number.NaN, endOffset: 10 }, // non-integer
        ]) {
            const segments = buildTranscriptHighlights(TEXT, [bad]);
            expect(roundTrip(segments)).toBe(TEXT);
            expect(segments.some((s) => s.highlighted)).toBe(false);
        }
    });

    it('returns one unhighlighted run when there are no spans', () => {
        expect(buildTranscriptHighlights(TEXT, [])).toEqual([{ text: TEXT, highlighted: false }]);
    });

    it('returns nothing for empty text', () => {
        expect(buildTranscriptHighlights('', [{ startOffset: 0, endOffset: 5 }])).toEqual([]);
    });
});

describe('hasSegmentProvenance (TASK-533 B5)', () => {
    it('is true only when EVERY span resolved to a segment', () => {
        expect(hasSegmentProvenance([{ startOffset: 0, endOffset: 5, segmentId: 'seg-1' }])).toBe(true);
        expect(
            hasSegmentProvenance([
                { startOffset: 0, endOffset: 5, segmentId: 'seg-1' },
                { startOffset: 6, endOffset: 9, segmentId: null },
            ]),
        ).toBe(false);
    });

    it('is false with no spans — absence of evidence is not provenance', () => {
        expect(hasSegmentProvenance([])).toBe(false);
    });
});
