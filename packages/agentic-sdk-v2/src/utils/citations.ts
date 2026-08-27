/**
 * @arcaai/vox - Citations / provenance utilities
 *
 * Pure, framework-agnostic helpers that back the linked-evidence clinician
 * review UI. Kept side-effect free so they can be unit-tested in isolation and
 * reused outside React.
 */
import type {
  CitationClaim,
  ClaimStatus,
  DocumentSectionGroup,
  DocumentSectionKey,
  DocumentSectionSpec,
  HighlightSegment,
  LegacySoapSectionCode,
} from '../types/citations';

/**
 * Canonical order of the four LEGACY SOAP section codes.
 *
 * Still exported, still exactly these four, and still the default grouping for
 * a note whose claims carry only legacy codes — because that is what
 * `apps/harness` emits today. It is no longer the only section vocabulary the
 * helpers below understand: see `groupClaimsBySection`.
 */
export const SOAP_SECTIONS: readonly LegacySoapSectionCode[] = ['S', 'O', 'A', 'P'] as const;

/** Human-readable labels for the four legacy SOAP section codes. */
export const SOAP_SECTION_LABELS: Record<LegacySoapSectionCode, string> = {
  S: 'Subjective',
  O: 'Objective',
  A: 'Assessment',
  P: 'Plan',
};

/** Turn `hospital_course` / `follow-up` into `Hospital Course` / `Follow Up`. */
function humanizeSectionKey(key: string): string {
  return key
    .split(/[_\-\s]+/)
    .filter((word) => word.length > 0)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * The label to render for a section key.
 *
 * Resolution order — explicit label, then the canonical label for a legacy
 * SOAP code, then a humanized form of the key. The explicit map comes first so
 * a caller holding the tenant's compiled template can render its authored
 * TITLE ("Reason for Admission") rather than a mechanical de-snake-casing of
 * the key ("Admission Reason").
 */
export function labelForSection(section: DocumentSectionKey, labels?: Record<string, string>): string {
  const explicit = labels?.[section];
  if (explicit !== undefined) return explicit;

  const legacy = (SOAP_SECTION_LABELS as Record<string, string>)[section];
  if (legacy !== undefined) return legacy;

  return humanizeSectionKey(section) || section;
}

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
 * Group claims by document section, so the note renders with a stable,
 * complete structure.
 *
 * ## Pass `sections` whenever you can
 *
 * With an explicit list — the section keys of the tenant's pinned
 * `DocumentTemplateVersion`, optionally paired with their authored titles —
 * you get exactly those groups, in that order, **including empty ones**. That
 * is the complete-structure guarantee this helper exists for: a section the
 * clinician has not filled in must still be visible as an empty heading, or
 * the omission is invisible. A claim whose section is not in the list is
 * dropped, deliberately: the template is the authority on what the document
 * contains.
 *
 * ## Without `sections`, the sections are inferred
 *
 * - Claims carrying only LEGACY SOAP codes (what `apps/harness` emits today),
 *   or no claims at all, group into the same four S/O/A/P sections, in the
 *   same order, with the same labels as before TASK-810. This is the
 *   backward-compatible path and it is byte-identical to the old behaviour.
 * - As soon as any claim carries a template section key, the groups are
 *   derived from the claims themselves in first-appearance order — so a
 *   discharge summary renders its own sections instead of four phantom SOAP
 *   headings it never declared.
 *
 * Inference cannot know about a section with no claims, which is exactly why
 * the explicit form is preferred for rendering.
 */
export function groupClaimsBySection(claims: CitationClaim[], sections?: readonly DocumentSectionSpec[]): DocumentSectionGroup[] {
  const specs = sections ?? inferSections(claims);

  return specs.map((spec) => {
    const key = typeof spec === 'string' ? spec : spec.key;
    const label = typeof spec === 'string' ? labelForSection(key) : spec.label;
    return { section: key, label, claims: claims.filter((claim) => claim.section === key) };
  });
}

/** Distinct sections present on the claims, or the legacy four when they all are. */
function inferSections(claims: CitationClaim[]): readonly DocumentSectionKey[] {
  const legacy = new Set<string>(SOAP_SECTIONS);
  const seen: DocumentSectionKey[] = [];

  let sawNonLegacy = false;
  for (const claim of claims) {
    if (!legacy.has(claim.section)) sawNonLegacy = true;
    if (!seen.includes(claim.section)) seen.push(claim.section);
  }

  return sawNonLegacy ? seen : SOAP_SECTIONS;
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
