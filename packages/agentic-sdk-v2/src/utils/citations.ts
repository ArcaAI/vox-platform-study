/**
 * @arcaai/vox - Citations / provenance utilities
 *
 * Pure, framework-agnostic helpers that back the linked-evidence clinician
 * review UI. Kept side-effect free so they can be unit-tested in isolation and
 * reused outside React.
 */
import type { CitationClaim, ClaimStatus, HighlightSegment, SoapSection, SoapSectionGroup } from '../types/citations';

/** Canonical SOAP section order. */
export const SOAP_SECTIONS: readonly SoapSection[] = ['S', 'O', 'A', 'P'] as const;

/** Human-readable SOAP section labels. */
export const SOAP_SECTION_LABELS: Record<SoapSection, string> = {
  S: 'Subjective',
  O: 'Objective',
  A: 'Assessment',
  P: 'Plan',
};

/**
 * Float-to-top ranking: actively contradicted claims first, then claims with no
 * provenance, verified claims last. This is the core anti-omission ordering —
 * the things a clinician must look at surface above everything else.
 */
const STATUS_ATTENTION_RANK: Record<ClaimStatus, number> = {
  flagged: 0,
  unverified: 1,
  verified: 2,
};

/** A claim needs human attention unless a sensor verified it. */
export function isNeedsAttention(status: ClaimStatus): boolean {
  return status !== 'verified';
}

/**
 * Stable sort that floats flagged → unverified → verified to the top while
 * preserving source order within each status group. Does not mutate the input.
 */
export function sortClaimsByAttention(claims: CitationClaim[]): CitationClaim[] {
  return claims
    .map((claim, index) => ({ claim, index }))
    .sort((a, b) => {
      const rank = STATUS_ATTENTION_RANK[a.claim.status] - STATUS_ATTENTION_RANK[b.claim.status];
      return rank !== 0 ? rank : a.index - b.index;
    })
    .map((entry) => entry.claim);
}

/**
 * The "needs attention" list: unverified + flagged claims only, floated with
 * flagged on top. Verified claims are excluded.
 */
export function selectClaimsNeedingAttention(claims: CitationClaim[]): CitationClaim[] {
  return sortClaimsByAttention(claims.filter((claim) => isNeedsAttention(claim.status)));
}

/**
 * Group claims into the four SOAP sections (always returned, in order, even
 * when empty) so the note renders with a stable, complete structure.
 */
export function groupClaimsBySection(claims: CitationClaim[]): SoapSectionGroup[] {
  return SOAP_SECTIONS.map((section) => ({
    section,
    label: SOAP_SECTION_LABELS[section],
    claims: claims.filter((claim) => claim.section === section),
  }));
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

/**
 * Split `text` into contiguous segments, marking which fall inside an evidence
 * span. Offsets are normalised defensively (clamped to the text bounds,
 * reversed pairs swapped, zero-width spans dropped) and overlapping/adjacent
 * spans are merged, so the concatenated segment text always equals the input.
 *
 * With no (valid) spans, non-empty text returns a single non-highlighted
 * segment; empty text returns `[]`.
 */
export function buildTranscriptHighlights(text: string, spans: Array<{ startOffset: number; endOffset: number }>): HighlightSegment[] {
  const length = text.length;

  const normalised = spans
    .map((span) => ({
      start: clamp(Math.min(span.startOffset, span.endOffset), 0, length),
      end: clamp(Math.max(span.startOffset, span.endOffset), 0, length),
    }))
    .filter((span) => span.end > span.start)
    .sort((a, b) => a.start - b.start || a.end - b.end);

  const merged: Array<{ start: number; end: number }> = [];
  for (const span of normalised) {
    const last = merged[merged.length - 1];
    if (last && span.start <= last.end) {
      last.end = Math.max(last.end, span.end);
    } else {
      merged.push({ ...span });
    }
  }

  if (merged.length === 0) {
    return length > 0 ? [{ text, highlighted: false }] : [];
  }

  const segments: HighlightSegment[] = [];
  let cursor = 0;
  for (const span of merged) {
    if (span.start > cursor) {
      segments.push({ text: text.slice(cursor, span.start), highlighted: false });
    }
    segments.push({ text: text.slice(span.start, span.end), highlighted: true });
    cursor = span.end;
  }
  if (cursor < length) {
    segments.push({ text: text.slice(cursor), highlighted: false });
  }
  return segments;
}

/** Round a 0–1 confidence to a clamped whole percentage. */
export function confidencePercent(confidence: number): number {
  return Math.round(clamp(confidence, 0, 1) * 100);
}
