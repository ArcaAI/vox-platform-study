/**
 * RE-ANCHORING: global document offsets → section-local ones.
 *
 * ## The problem, precisely
 *
 * Today every annotation on the live feed is addressed into ONE concatenated
 * `runningSummary`: `LiveSummaryEntityDto.start/end`,
 * `LiveSummaryGroundednessSegmentDto.start/end` and
 * `LiveSummaryFlaggedSpanDto.start/end` are all global character offsets, and a
 * section's `content` is documented as "a contiguous substring" of that string.
 *
 * That is sound for exactly one document rebuilt whole on every flush. Stream
 * sections independently — the point of multi-document — and every offset after
 * a growing section is wrong the moment that section grows: add one character to
 * `subjective` and every highlight in `assessment` and `plan` shifts by one, with
 * nothing in the payload to say so.
 *
 * ## The fix
 *
 * Re-address each annotation to `{documentKey, sectionKey, local offset}`. A
 * section's spans then index that section's own content, so they stay valid
 * however much any OTHER section changes. This module is the pure function that
 * performs the translation; it is deliberately separate from the store so it can
 * be tested against the property that matters (an earlier section growing must
 * not move a later section's offsets) without a database.
 *
 * ## Why locate by scanning rather than by arithmetic
 *
 * `buildRunningSummary` joins trimmed, non-empty section contents with `\n\n`,
 * so the offsets are derivable arithmetically — but only while that function
 * keeps that exact shape. Scanning with a forward-only cursor gets the same
 * answer and stays correct if the join ever changes, which is the kind of coupling
 * that silently mis-highlights clinical text rather than failing loudly.
 */
import type { LiveSummaryEntityDto, LiveSummaryGroundednessDto, LiveSummarySectionDto } from '../dto';
import type { SectionAnnotationDto } from './dto/section-patch.dto';

/** Where one section's content sits inside the concatenated document. */
export interface SectionSpan {
  readonly section: LiveSummarySectionDto;
  readonly index: number;
  /** Inclusive start offset in the concatenated document, or -1 when not located. */
  readonly start: number;
  /** Exclusive end offset. */
  readonly end: number;
}

/**
 * Locate every section inside the concatenated document.
 *
 * Forward-only cursor, so two sections with identical content resolve to their
 * OWN occurrences rather than both to the first one — a real case, since an
 * unpopulated section renders as the same empty string as its neighbour.
 */
export function locateSections(sections: readonly LiveSummarySectionDto[], document: string): SectionSpan[] {
  let cursor = 0;
  return sections.map((section, index) => {
    const content = section.content.trim();
    if (content.length === 0) return { section, index, start: -1, end: -1 };
    const start = document.indexOf(content, cursor);
    if (start < 0) return { section, index, start: -1, end: -1 };
    cursor = start + content.length;
    return { section, index, start, end: start + content.length };
  });
}

function localSpan(span: SectionSpan, start?: number, end?: number): { start: number; end: number } | null {
  if (span.start < 0 || typeof start !== 'number' || typeof end !== 'number') return null;
  // Strictly INSIDE the section. An annotation straddling a section boundary is
  // dropped rather than clamped: a clamped highlight would silently point at text
  // the annotation was not made about.
  if (start < span.start || end > span.end) return null;
  return { start: start - span.start, end: end - span.start };
}

/**
 * Re-anchor a flush's annotations onto their sections.
 *
 * Returns one entry per section, in section order, carrying only the annotations
 * that fall wholly within it. Sections that could not be located in the document
 * (empty, or content the parser transformed) receive an empty list — never a
 * guessed offset.
 */
export function reanchorAnnotations(
  sections: readonly LiveSummarySectionDto[],
  document: string,
  entities: readonly LiveSummaryEntityDto[],
  groundedness?: LiveSummaryGroundednessDto,
  /**
   * Lane N — the tenant's IMPORTANT FINDINGS. Shaped like entities (so they re-anchor through the
   * identical code path) but annotated under their own `finding` kind, because "a detector
   * recognised this" and "the tenant's instruction says this matters" are different claims and a
   * console has to be able to render them differently.
   */
  findings: readonly LiveSummaryEntityDto[] = [],
): SectionAnnotationDto[][] {
  const spans = locateSections(sections, document);

  return spans.map((span) => {
    const annotations: SectionAnnotationDto[] = [];

    for (const entity of entities) {
      const local = localSpan(span, entity.start, entity.end);
      if (!local) continue;
      annotations.push({
        kind: 'entity',
        start: local.start,
        end: local.end,
        type: entity.type,
        ...(entity.icd10 ? { icd10: entity.icd10 } : {}),
        ...(typeof entity.confidence === 'number' ? { score: entity.confidence } : {}),
      });
    }

    for (const finding of findings) {
      const local = localSpan(span, finding.start, finding.end);
      if (!local) continue;
      annotations.push({
        kind: 'finding',
        start: local.start,
        end: local.end,
        type: finding.type,
        ...(typeof finding.confidence === 'number' ? { score: finding.confidence } : {}),
      });
    }

    for (const segment of groundedness?.segments ?? []) {
      const local = localSpan(span, segment.start, segment.end);
      if (!local) continue;
      annotations.push({
        kind: 'groundedness',
        start: local.start,
        end: local.end,
        verdict: segment.verdict,
        ...(typeof segment.score === 'number' ? { score: segment.score } : {}),
      });
    }

    for (const flagged of groundedness?.flaggedSpans ?? []) {
      const local = localSpan(span, flagged.start, flagged.end);
      if (!local) continue;
      annotations.push({ kind: 'flagged', start: local.start, end: local.end });
    }

    // Stable order so a diff between two flushes is about CONTENT, not ordering.
    return annotations.sort((a, b) => a.start - b.start || a.end - b.end || a.kind.localeCompare(b.kind));
  });
}
