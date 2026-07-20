/**
 * segment-level transcript helpers (pure, no I/O).
 *
 * STT emits per-segment metadata (start/end timestamps, speaker, and a text
 * slice) for a finalized transcript. These helpers:
 *   1. Resolve each segment's [charStart, charEnd) character offsets into the
 *      transcript text (`computeSegmentOffsets`) so segments anchor to the
 *      exact source span WITHOUT persisting the (PHI) segment text — the offset
 *      pair is enough to recover the slice from the transcript's content.
 *   2. Resolve a character offset back to the segment that contains it
 *      (`resolveSegmentIdForOffset`) — the NER-grounding primitive: an entity's
 *      transcript offset maps to its source segment id.
 *   3. Attach the resolved `segmentId` onto each evidence span of a
 *      `citationsMap` (`attachSegmentEvidence`) so `SummaryMeta.citationsMap`
 *      carries sentence-level segment provenance (the shipped evidence-link
 *      path; a future console click-to-source seeks the audio via t0/t1).
 *
 * All functions are pure and side-effect-free so they are trivially unit-tested
 * and reused across the STT ingest + the harness persist paths.
 */

/** Raw per-segment metadata as emitted by STT (camelCase at the API boundary). */
export interface TranscriptSegmentInputShape {
  /** 0-based ordinal within the transcript; defaults to array position. */
  idx?: number;
  /** Segment start time (ms from recording start). */
  t0Ms?: number | null;
  /** Segment end time (ms from recording start). */
  t1Ms?: number | null;
  /** Diarization / speaker label. */
  speaker?: string | null;
  /** The segment's text slice — used ONLY to resolve offsets; never persisted. */
  text?: string | null;
  /** Explicit character offset into the transcript (wins over text-search). */
  charStart?: number | null;
  charEnd?: number | null;
}

/** A segment with its ordinal + resolved (possibly null) offsets. */
export interface ResolvedTranscriptSegment {
  idx: number;
  t0Ms: number | null;
  t1Ms: number | null;
  speaker: string | null;
  charStart: number | null;
  charEnd: number | null;
}

/** Minimal shape needed to map an offset back to a persisted segment id. */
export interface SegmentOffsetRef {
  id: string;
  charStart: number | null;
  charEnd: number | null;
}

/**
 * Resolve each input segment's ordinal + [charStart, charEnd) offsets against
 * the transcript text. Offset resolution order per segment:
 *   1. Explicit `charStart`/`charEnd` on the input (STT already computed them).
 *   2. Locate `text` in the transcript starting at a running cursor (so
 *      repeated phrases resolve to the correct, in-order occurrence).
 *   3. Otherwise leave offsets null (a text-only / timings-only segment still
 *      persists with its ordinal + timings).
 * The running cursor only advances on a successful text match, so a segment
 * whose text is missing does not corrupt the offsets of later segments.
 */
export function computeSegmentOffsets(
  transcriptText: string,
  segments: readonly TranscriptSegmentInputShape[],
): ResolvedTranscriptSegment[] {
  const text = transcriptText ?? '';
  let cursor = 0;
  return segments.map((seg, position) => {
    let charStart = seg.charStart ?? null;
    let charEnd = seg.charEnd ?? null;

    if ((charStart === null || charEnd === null) && seg.text && seg.text.length > 0) {
      const found = text.indexOf(seg.text, cursor);
      if (found >= 0) {
        charStart = found;
        charEnd = found + seg.text.length;
        cursor = charEnd;
      }
    } else if (charStart !== null && charEnd !== null) {
      // Explicit offsets provided — keep the cursor monotonic for later searches.
      cursor = Math.max(cursor, charEnd);
    }

    return {
      idx: seg.idx ?? position,
      t0Ms: seg.t0Ms ?? null,
      t1Ms: seg.t1Ms ?? null,
      speaker: seg.speaker ?? null,
      charStart,
      charEnd,
    };
  });
}

/**
 * Resolve a character offset to the id of the segment whose half-open
 * [charStart, charEnd) span contains it. Returns null when no segment covers
 * the offset (or the offset is not a finite number). Segments with null
 * offsets are skipped.
 */
export function resolveSegmentIdForOffset(
  segments: readonly SegmentOffsetRef[],
  offset: number | null | undefined,
): string | null {
  if (offset === null || offset === undefined || !Number.isFinite(offset)) {
    return null;
  }
  for (const seg of segments) {
    if (seg.charStart === null || seg.charEnd === null) continue;
    if (offset >= seg.charStart && offset < seg.charEnd) {
      return seg.id;
    }
  }
  return null;
}

/**
 * Return a copy of `citationsMap` with each claim's evidence span annotated
 * with the `segmentId` that contains its transcript `startOffset` (resolved via
 * `resolveSegmentIdForOffset`). Evidence whose offset falls in no segment is
 * left untouched (segmentId omitted) — mirroring the StrictCitations posture
 * where an unresolvable reference is simply dropped rather than fabricated.
 *
 * Non-destructive: returns a new object graph and never mutates the input.
 * Tolerant of a null/shapeless map (returns it as-is).
 */
export function attachSegmentEvidence(
  citationsMap: Record<string, unknown> | null | undefined,
  segments: readonly SegmentOffsetRef[],
): Record<string, unknown> | null | undefined {
  if (!citationsMap || typeof citationsMap !== 'object') return citationsMap;
  const claims = (citationsMap as { claims?: unknown }).claims;
  if (!Array.isArray(claims) || segments.length === 0) return citationsMap;

  const enrichedClaims = claims.map((claim) => {
    if (!claim || typeof claim !== 'object') return claim;
    const evidence = (claim as { evidence?: unknown }).evidence;
    if (!Array.isArray(evidence)) return claim;
    const enrichedEvidence = evidence.map((span) => {
      if (!span || typeof span !== 'object') return span;
      const startOffset = (span as { startOffset?: unknown }).startOffset;
      const segmentId = resolveSegmentIdForOffset(
        segments,
        typeof startOffset === 'number' ? startOffset : null,
      );
      return segmentId ? { ...(span as object), segmentId } : span;
    });
    return { ...(claim as object), evidence: enrichedEvidence };
  });

  return { ...citationsMap, claims: enrichedClaims };
}
