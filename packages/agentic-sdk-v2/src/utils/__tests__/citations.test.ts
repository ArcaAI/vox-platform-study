/**
 * @arcaai/vox - Citations / provenance utilities
 *
 * These pure helpers back the linked-evidence clinician review UI:
 *   - float-to-top ordering of unverified/flagged claims (anti-omission UX)
 *   - SOAP-section grouping of the drafted note
 *   - transcript highlight segmentation by evidence char-offsets
 */
import { describe, it, expect } from 'vitest';
import {
  isNeedsAttention,
  sortClaimsByAttention,
  selectClaimsNeedingAttention,
  groupClaimsBySection,
  buildTranscriptHighlights,
  confidencePercent,
  SOAP_SECTIONS,
  SOAP_SECTION_LABELS,
} from '../citations';
import type { CitationClaim, SoapSection, ClaimStatus } from '../../types/citations';

function claim(id: string, section: SoapSection, status: ClaimStatus, overrides: Partial<CitationClaim> = {}): CitationClaim {
  return {
    id,
    text: `claim ${id}`,
    section,
    status,
    confidence: 0.8,
    evidence: [],
    entityRefs: [],
    knowledgeChunkIds: [],
    ...overrides,
  };
}

describe('isNeedsAttention', () => {
  it('treats unverified and flagged as needing attention, verified as not', () => {
    expect(isNeedsAttention('flagged')).toBe(true);
    expect(isNeedsAttention('unverified')).toBe(true);
    expect(isNeedsAttention('verified')).toBe(false);
  });
});

describe('sortClaimsByAttention', () => {
  it('floats flagged first, then unverified, then verified', () => {
    const input = [
      claim('a', 'S', 'verified'),
      claim('b', 'O', 'unverified'),
      claim('c', 'A', 'flagged'),
      claim('d', 'P', 'verified'),
    ];
    expect(sortClaimsByAttention(input).map((c) => c.id)).toEqual(['c', 'b', 'a', 'd']);
  });

  it('is stable within a status group (preserves source order)', () => {
    const input = [
      claim('v1', 'S', 'verified'),
      claim('u1', 'S', 'unverified'),
      claim('u2', 'O', 'unverified'),
      claim('v2', 'A', 'verified'),
    ];
    expect(sortClaimsByAttention(input).map((c) => c.id)).toEqual(['u1', 'u2', 'v1', 'v2']);
  });

  it('does not mutate the input array', () => {
    const input = [claim('a', 'S', 'verified'), claim('b', 'O', 'flagged')];
    const before = input.map((c) => c.id);
    sortClaimsByAttention(input);
    expect(input.map((c) => c.id)).toEqual(before);
  });
});

describe('selectClaimsNeedingAttention', () => {
  it('drops verified claims and floats flagged above unverified', () => {
    const input = [
      claim('v', 'S', 'verified'),
      claim('u', 'O', 'unverified'),
      claim('f', 'A', 'flagged'),
    ];
    const out = selectClaimsNeedingAttention(input);
    expect(out.map((c) => c.id)).toEqual(['f', 'u']);
  });

  it('returns an empty array when everything is verified', () => {
    expect(selectClaimsNeedingAttention([claim('a', 'S', 'verified')])).toEqual([]);
  });
});

describe('groupClaimsBySection', () => {
  it('returns the four SOAP sections in order with their claims and labels', () => {
    const input = [
      claim('p1', 'P', 'verified'),
      claim('s1', 'S', 'unverified'),
      claim('a1', 'A', 'flagged'),
      claim('s2', 'S', 'verified'),
    ];
    const groups = groupClaimsBySection(input);
    expect(groups.map((g) => g.section)).toEqual(['S', 'O', 'A', 'P']);
    expect(groups.map((g) => g.label)).toEqual(['Subjective', 'Objective', 'Assessment', 'Plan']);
    expect(groups[0].claims.map((c) => c.id)).toEqual(['s1', 's2']);
    expect(groups[1].claims).toEqual([]);
    expect(groups[2].claims.map((c) => c.id)).toEqual(['a1']);
    expect(groups[3].claims.map((c) => c.id)).toEqual(['p1']);
  });

  it('exposes the canonical SOAP order + labels', () => {
    expect(SOAP_SECTIONS).toEqual(['S', 'O', 'A', 'P']);
    expect(SOAP_SECTION_LABELS).toEqual({ S: 'Subjective', O: 'Objective', A: 'Assessment', P: 'Plan' });
  });
});

describe('buildTranscriptHighlights', () => {
  const text = 'The patient has chest pain and shortness of breath.';
  //            0123456789...                  ^16        ^26

  it('returns a single non-highlighted segment when there are no spans', () => {
    expect(buildTranscriptHighlights(text, [])).toEqual([{ text, highlighted: false }]);
  });

  it('returns [] for empty text', () => {
    expect(buildTranscriptHighlights('', [{ startOffset: 0, endOffset: 4 }])).toEqual([]);
  });

  it('splits the text into pre / highlight / post around a single span', () => {
    const segs = buildTranscriptHighlights(text, [{ startOffset: 16, endOffset: 26 }]);
    expect(segs).toEqual([
      { text: 'The patient has ', highlighted: false },
      { text: 'chest pain', highlighted: true },
      { text: ' and shortness of breath.', highlighted: false },
    ]);
    // round-trips back to the original text
    expect(segs.map((s) => s.text).join('')).toBe(text);
  });

  it('highlights a span at the very start (no empty leading segment)', () => {
    const segs = buildTranscriptHighlights(text, [{ startOffset: 0, endOffset: 3 }]);
    expect(segs[0]).toEqual({ text: 'The', highlighted: true });
    expect(segs.map((s) => s.text).join('')).toBe(text);
  });

  it('clamps out-of-range offsets to the text bounds', () => {
    const segs = buildTranscriptHighlights('abc', [{ startOffset: -5, endOffset: 999 }]);
    expect(segs).toEqual([{ text: 'abc', highlighted: true }]);
  });

  it('normalises reversed offsets (start > end)', () => {
    const segs = buildTranscriptHighlights('abcdef', [{ startOffset: 4, endOffset: 1 }]);
    expect(segs).toEqual([
      { text: 'a', highlighted: false },
      { text: 'bcd', highlighted: true },
      { text: 'ef', highlighted: false },
    ]);
  });

  it('merges overlapping and adjacent spans into one highlight', () => {
    const segs = buildTranscriptHighlights('abcdefghij', [
      { startOffset: 1, endOffset: 4 },
      { startOffset: 3, endOffset: 6 }, // overlaps the first
      { startOffset: 6, endOffset: 8 }, // adjacent to the merged run
    ]);
    expect(segs).toEqual([
      { text: 'a', highlighted: false },
      { text: 'bcdefgh', highlighted: true },
      { text: 'ij', highlighted: false },
    ]);
  });

  it('supports multiple disjoint highlights', () => {
    const segs = buildTranscriptHighlights('abcdefghij', [
      { startOffset: 0, endOffset: 2 },
      { startOffset: 5, endOffset: 7 },
    ]);
    expect(segs).toEqual([
      { text: 'ab', highlighted: true },
      { text: 'cde', highlighted: false },
      { text: 'fg', highlighted: true },
      { text: 'hij', highlighted: false },
    ]);
  });

  it('ignores zero-width spans', () => {
    expect(buildTranscriptHighlights('abc', [{ startOffset: 2, endOffset: 2 }])).toEqual([{ text: 'abc', highlighted: false }]);
  });
});

describe('confidencePercent', () => {
  it('rounds a 0–1 confidence to a whole percentage', () => {
    expect(confidencePercent(0.823)).toBe(82);
    expect(confidencePercent(0.5)).toBe(50);
  });

  it('clamps out-of-range values', () => {
    expect(confidencePercent(-0.2)).toBe(0);
    expect(confidencePercent(1.5)).toBe(100);
  });
});
