/**
 * @arcaai/vox — N-section document support in the citations helpers
 * ( carry-over B).
 *
 * `SoapSection` was a CLOSED four-value union (`'S'|'O'|'A'|'P'`) and
 * `groupClaimsBySection` always returned exactly four groups. That made the
 * SDK the deepest structural commitment to four sections in the codebase: a
 * tenant whose published `DocumentTemplate` is a ten-section discharge summary
 * could not even TYPE a claim against it, let alone render one.
 *
 * The section key is now open. These cases pin the new capability AND the
 * backward compatibility that lets it ship without breaking a caller:
 * `groupClaimsBySection(claims)` with legacy SOAP claims still returns the same
 * four groups, in the same order, with the same labels.
 *
 * The legacy-vs-open split is real, not cosmetic: `apps/harness` still emits
 * single-letter S/O/A/P codes (`sensors/aggregator.py`), so both alphabets are
 * live on the wire simultaneously.
 */
import { describe, it, expect } from 'vitest';
import { groupClaimsBySection, labelForSection, SOAP_SECTIONS, SOAP_SECTION_LABELS } from '../citations';
import type { CitationClaim, ClaimStatus, DocumentSectionKey } from '../../types/citations';

function claim(id: string, section: DocumentSectionKey, status: ClaimStatus = 'verified'): CitationClaim {
  return {
    id,
    text: `claim ${id}`,
    section,
    status,
    confidence: 0.8,
    evidence: [],
    entityRefs: [],
    knowledgeChunkIds: [],
  };
}

describe('DocumentSectionKey — the union is open', () => {
  it('accepts an arbitrary template section key on a claim', () => {
    // Compile-time assertion first and foremost: under the old closed union
    // this line did not type-check at all.
    const c = claim('h1', 'hospital_course');
    expect(c.section).toBe('hospital_course');
  });

  it('still accepts the legacy single-letter SOAP codes the harness emits', () => {
    expect(claim('s1', 'S').section).toBe('S');
  });
});

describe('labelForSection', () => {
  it('returns the canonical label for a legacy SOAP code', () => {
    expect(labelForSection('S')).toBe('Subjective');
    expect(labelForSection('P')).toBe('Plan');
  });

  it('humanizes an unknown template section key', () => {
    expect(labelForSection('hospital_course')).toBe('Hospital Course');
    expect(labelForSection('follow-up')).toBe('Follow Up');
  });

  it('prefers an explicitly supplied label over both', () => {
    expect(labelForSection('hospital_course', { hospital_course: 'Course in Hospital' })).toBe('Course in Hospital');
    expect(labelForSection('S', { S: 'Story' })).toBe('Story');
  });

  it('falls back to the raw key when it cannot be humanized', () => {
    expect(labelForSection('')).toBe('');
  });
});

describe('groupClaimsBySection — backward compatibility', () => {
  it('returns the same four SOAP groups, in order, for legacy claims with no section list', () => {
    const input = [claim('p1', 'P'), claim('s1', 'S', 'unverified'), claim('a1', 'A', 'flagged'), claim('s2', 'S')];
    const groups = groupClaimsBySection(input);

    expect(groups.map((g) => g.section)).toEqual(['S', 'O', 'A', 'P']);
    expect(groups.map((g) => g.label)).toEqual(['Subjective', 'Objective', 'Assessment', 'Plan']);
    expect(groups[0].claims.map((c) => c.id)).toEqual(['s1', 's2']);
    expect(groups[1].claims).toEqual([]);
  });

  it('returns the four SOAP groups for an empty claim list', () => {
    expect(groupClaimsBySection([]).map((g) => g.section)).toEqual(['S', 'O', 'A', 'P']);
  });

  it('keeps exporting the canonical legacy order and labels unchanged', () => {
    expect(SOAP_SECTIONS).toEqual(['S', 'O', 'A', 'P']);
    expect(SOAP_SECTION_LABELS).toEqual({ S: 'Subjective', O: 'Objective', A: 'Assessment', P: 'Plan' });
  });
});

describe('groupClaimsBySection — N sections', () => {
  const discharge = [
    claim('c1', 'hospital_course'),
    claim('r1', 'admission_reason'),
    claim('f1', 'follow_up', 'flagged'),
    claim('c2', 'hospital_course', 'unverified'),
  ];

  it('groups on an EXPLICIT section list, in that order, including empty sections', () => {
    const groups = groupClaimsBySection(discharge, ['admission_reason', 'hospital_course', 'discharge_medications', 'follow_up', 'red_flags']);

    expect(groups.map((g) => g.section)).toEqual(['admission_reason', 'hospital_course', 'discharge_medications', 'follow_up', 'red_flags']);
    expect(groups.map((g) => g.label)).toEqual(['Admission Reason', 'Hospital Course', 'Discharge Medications', 'Follow Up', 'Red Flags']);
    expect(groups[1].claims.map((c) => c.id)).toEqual(['c1', 'c2']);
    expect(groups[2].claims).toEqual([]);
  });

  it('accepts a section list of {key,label} pairs so a template title wins over the humanized key', () => {
    const groups = groupClaimsBySection(discharge, [
      { key: 'admission_reason', label: 'Reason for Admission' },
      { key: 'hospital_course', label: 'Hospital Course' },
    ]);

    expect(groups.map((g) => g.label)).toEqual(['Reason for Admission', 'Hospital Course']);
  });

  it('derives the sections FROM the claims (first-appearance order) when none are supplied', () => {
    const groups = groupClaimsBySection(discharge);

    expect(groups.map((g) => g.section)).toEqual(['hospital_course', 'admission_reason', 'follow_up']);
    // No phantom S/O/A/P groups for a tenant whose template has no such sections.
    expect(groups.map((g) => g.section)).not.toContain('S');
  });

  it('drops a claim into no group when its section is outside an explicit list', () => {
    const groups = groupClaimsBySection(discharge, ['admission_reason']);
    expect(groups).toHaveLength(1);
    expect(groups[0].claims.map((c) => c.id)).toEqual(['r1']);
  });

  it('handles a MIXED note by deriving every distinct section present', () => {
    const groups = groupClaimsBySection([claim('s1', 'S'), claim('h1', 'hospital_course')]);
    expect(groups.map((g) => g.section)).toEqual(['S', 'hospital_course']);
    expect(groups.map((g) => g.label)).toEqual(['Subjective', 'Hospital Course']);
  });

  it('does not mind a ten-section template', () => {
    const keys = Array.from({ length: 10 }, (_, i) => `section_${i}`);
    const groups = groupClaimsBySection([claim('x', 'section_7')], keys);
    expect(groups).toHaveLength(10);
    expect(groups[7].claims.map((c) => c.id)).toEqual(['x']);
  });
});
