/**
 * Click-to-source highlighting (TASK-533 B5, GAP-A2).
 *
 * Pure — no React, no I/O — so the offset arithmetic that decides which words a
 * clinician sees marked as evidence is testable in isolation. That matters more
 * than usual here: an off-by-one silently attributes a claim to the wrong span
 * of the transcript, which is a clinical-trust failure, not a cosmetic one.
 */

/** One evidence span into the transcript's character space. */
export interface EvidenceSpan {
    startOffset: number;
    endOffset: number;
    /** Resolved by the D-22 chain; null when the claim has no segment provenance. */
    segmentId?: string | null;
}

/** A run of transcript text, flagged if it is cited by the selected claim. */
export interface HighlightSegment {
    text: string;
    highlighted: boolean;
}

/**
 * Split `text` into alternating plain/highlighted runs for `spans`.
 *
 * Overlapping and out-of-order spans are normalised (sorted + merged) rather
 * than rejected: two claims can legitimately cite overlapping evidence, and
 * rendering nested `<mark>` elements would double-emphasise the overlap.
 * Degenerate spans (reversed, out of range, zero-width) are dropped — a bad
 * offset must never shift the surrounding text.
 */
export function buildTranscriptHighlights(text: string, spans: readonly EvidenceSpan[]): HighlightSegment[] {
    if (!text) return [];

    const usable = spans
        .filter((s) => Number.isInteger(s.startOffset) && Number.isInteger(s.endOffset))
        .map((s) => ({ start: Math.max(0, s.startOffset), end: Math.min(text.length, s.endOffset) }))
        .filter((s) => s.end > s.start)
        .sort((a, b) => a.start - b.start);

    if (usable.length === 0) return [{ text, highlighted: false }];

    // Merge overlaps/adjacency so each character is emitted exactly once.
    const merged: { start: number; end: number }[] = [];
    for (const span of usable) {
        const last = merged[merged.length - 1];
        if (last && span.start <= last.end) {
            last.end = Math.max(last.end, span.end);
        } else {
            merged.push({ ...span });
        }
    }

    const out: HighlightSegment[] = [];
    let cursor = 0;
    for (const span of merged) {
        if (span.start > cursor) out.push({ text: text.slice(cursor, span.start), highlighted: false });
        out.push({ text: text.slice(span.start, span.end), highlighted: true });
        cursor = span.end;
    }
    if (cursor < text.length) out.push({ text: text.slice(cursor), highlighted: false });

    return out;
}

/** True when every evidence span on a claim resolved to a transcript segment. */
export function hasSegmentProvenance(spans: readonly EvidenceSpan[]): boolean {
    return spans.length > 0 && spans.every((s) => !!s.segmentId);
}
