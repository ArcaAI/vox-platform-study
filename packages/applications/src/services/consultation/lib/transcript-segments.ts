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

/**
 * The LEGACY per-segment shape the batch producer used to emit via the untyped
 * `metadata.segments` fallback: snake_case, SECONDS as floats,
 * `speaker_id`, and no text at all.
 *
 * `apps/stt-v2` now emits the camelCase consumer shape on the typed `segments`
 * field, but this is retained deliberately: (a) in-flight/queued payloads and any
 * archived metadata blob still carry it, and (b) normalizing is strictly better
 * than the old behaviour, which silently coerced every field to null and wrote
 * rows carrying nothing but an ordinal — the defect itself.
 */
export interface LegacyTranscriptSegmentShape {
  start_time?: number | null;
  end_time?: number | null;
  speaker_id?: string | null;
  text?: string | null;
}

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
  segments: readonly (TranscriptSegmentInputShape | LegacyTranscriptSegmentShape)[],
  onUnusable?: (report: UnusableSegmentReport) => void,
): ResolvedTranscriptSegment[] {
  const text = transcriptText ?? '';
  let cursor = 0;
  return segments.map((raw, position) => {
    const seg = normalizeSegmentShape(raw);
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

    const resolved: ResolvedTranscriptSegment = {
      idx: seg.idx ?? position,
      t0Ms: seg.t0Ms ?? null,
      t1Ms: seg.t1Ms ?? null,
      speaker: seg.speaker ?? null,
      charStart,
      charEnd,
    };

    // A segment carrying NOTHING but its ordinal is the exact
    // signature of the defect: it persists a row that can never ground a claim
    // (`resolveSegmentIdForOffset` skips null offsets). It used to happen
    // silently on every batch transcript. Report it so the caller can log loudly
    // rather than let a producer regression hide behind a green ingest.
    if (onUnusable && resolved.charStart === null && resolved.t0Ms === null && resolved.speaker === null) {
      onUnusable({ position, keys: Object.keys((raw ?? {}) as Record<string, unknown>) });
    }

    return resolved;
  });
}

/** Describes a segment that resolved to nothing usable (see `onUnusable`). */
export interface UnusableSegmentReport {
  /** Array position of the offending segment. */
  position: number;
  /** The keys actually present on the raw input — the diagnostic that matters. */
  keys: string[];
}

/**
 * Coerce either accepted wire shape into the canonical camelCase/ms one.
 *
 * Normalization, NOT replacement: a payload already in the consumer shape passes
 * through untouched, so this is transparent for the fixed producers.
 */
function normalizeSegmentShape(raw: TranscriptSegmentInputShape | LegacyTranscriptSegmentShape): TranscriptSegmentInputShape {
  const seg = (raw ?? {}) as TranscriptSegmentInputShape & LegacyTranscriptSegmentShape;

  // Already canonical on a given axis ⇒ keep it; otherwise fall back to the legacy
  // key, converting seconds → integer milliseconds.
  const t0Ms = seg.t0Ms ?? (typeof seg.start_time === 'number' ? Math.round(seg.start_time * 1000) : null);
  const t1Ms = seg.t1Ms ?? (typeof seg.end_time === 'number' ? Math.round(seg.end_time * 1000) : null);

  return {
    idx: seg.idx,
    t0Ms,
    t1Ms,
    speaker: seg.speaker ?? seg.speaker_id ?? null,
    text: seg.text ?? null,
    charStart: seg.charStart,
    charEnd: seg.charEnd,
  };
}

/**
 * Resolve a character offset to the id of the segment whose half-open
 * [charStart, charEnd) span contains it. Returns null when no segment covers
 * the offset (or the offset is not a finite number). Segments with null
 * offsets are skipped.
 */
export function resolveSegmentIdForOffset(segments: readonly SegmentOffsetRef[], offset: number | null | undefined): string | null {
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
      const segmentId = resolveSegmentIdForOffset(segments, typeof startOffset === 'number' ? startOffset : null);
      return segmentId ? { ...(span as object), segmentId } : span;
    });
    return { ...(claim as object), evidence: enrichedEvidence };
  });

  return { ...citationsMap, claims: enrichedClaims };
}

/**
 * Collect every segment id referenced by a `citationsMap`, from BOTH shapes it
 * can carry (TASK-552 Lane C): the flat `segmentCitedIds` array (the
 * StrictCitations / EARLY-draft lane — `mergeSegmentCitedIds` above) and the
 * nested `claims[].evidence[].segmentId` (the NER-claims lane, annotated by
 * `attachSegmentEvidence`). Deduped, order-stable (`segmentCitedIds` first,
 * then claim evidence in encounter order) so a console evidence panel can
 * resolve ALL cited segments regardless of which lane produced them. Tolerant
 * of a null/shapeless map (returns `[]`).
 */
export function collectCitedSegmentIds(citationsMap: Record<string, unknown> | null | undefined): string[] {
  if (!citationsMap || typeof citationsMap !== 'object') return [];
  const seen = new Set<string>();
  const ids: string[] = [];

  const flat = (citationsMap as { segmentCitedIds?: unknown }).segmentCitedIds;
  if (Array.isArray(flat)) {
    for (const id of flat) {
      if (typeof id === 'string' && !seen.has(id)) {
        seen.add(id);
        ids.push(id);
      }
    }
  }

  const claims = (citationsMap as { claims?: unknown }).claims;
  if (Array.isArray(claims)) {
    for (const claim of claims) {
      const evidence = (claim as { evidence?: unknown } | null)?.evidence;
      if (!Array.isArray(evidence)) continue;
      for (const span of evidence) {
        const segmentId = (span as { segmentId?: unknown } | null)?.segmentId;
        if (typeof segmentId === 'string' && !seen.has(segmentId)) {
          seen.add(segmentId);
          ids.push(segmentId);
        }
      }
    }
  }

  return ids;
}

/** Matches a `[[seg:<id>]]` StrictCitations marker. Mirrors the harness-side
 * `SEGMENT_CITATION_MARKER_RE` (`apps/harness/src/harness/temporal/prompt_cache.py`)
 * so both sides parse the exact same wire format. */
const SEGMENT_CITATION_MARKER_RE = /\[\[seg:([^\]]+)\]\]/g;

/** Result of {@link extractAndStripSegmentCitationMarkers}. */
export interface SegmentCitationExtraction {
  /** `content` with every `[[seg:<id>]]` marker removed (whitespace collapsed). */
  content: string;
  /** Deduped, first-seen-order ids that were both cited AND in `allowedIds`. */
  citedSegmentIds: string[];
}

/**
 * Parse `[[seg:<id>]]` StrictCitations markers out of model-generated content,
 * mirroring `extract_cited_segment_ids` (`prompt_cache.py`) on the TS side of
 * the write path.
 *
 * Every marker is stripped from the returned `content` regardless of validity —
 * the delivered note must never show raw citation syntax to a clinician, an
 * unresolvable/hallucinated id is a hidden defect, not a reason to leave the
 * marker text in a clinical note. `citedSegmentIds` only keeps ids present in
 * `allowedIds` (the consultation's own persisted transcript segments), so a
 * hallucinated id can never be recorded as evidence — same posture as the
 * harness-side extractor.
 */
export function extractAndStripSegmentCitationMarkers(
  content: string | null | undefined,
  allowedIds: ReadonlySet<string>,
): SegmentCitationExtraction {
  const text = content ?? '';
  if (!text) {
    return { content: text, citedSegmentIds: [] };
  }

  const seen = new Set<string>();
  const citedSegmentIds: string[] = [];
  for (const match of text.matchAll(SEGMENT_CITATION_MARKER_RE)) {
    const id = match[1].trim();
    if (allowedIds.has(id) && !seen.has(id)) {
      seen.add(id);
      citedSegmentIds.push(id);
    }
  }

  const stripped = text
    .replace(SEGMENT_CITATION_MARKER_RE, '')
    // Markers are typically appended right after a sentence (`...daily [[seg:x]].`);
    // removing them can leave a stray space before trailing punctuation or a double
    // space where one stood between two words — tidy both without altering
    // deliberate whitespace/newlines elsewhere in the note.
    .replace(/ +([.,;:!?])/g, '$1')
    .replace(/[ \t]{2,}/g, ' ')
    .trim();

  return { content: stripped, citedSegmentIds };
}
