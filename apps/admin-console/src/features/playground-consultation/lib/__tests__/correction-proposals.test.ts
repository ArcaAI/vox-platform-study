/**
 * TASK-797 W2 — correction proposals are PROPOSALS. The hard product constraint:
 * the source text comes back byte-identical with `applied: false`, and nothing reaches
 * the note without an explicit clinician action.
 *
 * The subtle hazard this module exists for: accepting one proposal SHIFTS the offsets of
 * every later one whenever the replacement differs in length from the original. Applying a
 * second proposal on its original offsets would then splice over the wrong characters —
 * which, on a drug name or a dose, is a patient-safety defect. So every remaining proposal
 * is re-verified against the NEW text after each accept, and any that no longer verifies is
 * dropped rather than adjusted.
 */
import { describe, expect, it } from 'vitest';
import { applyProposal, verifiedProposals } from '../correction-proposals';
import type { CorrectionProposal } from '../../api/pending-contracts';

const TEXT = 'Patient started metfromin 500mg and lisinopril 10mg.';

function proposal(overrides: Partial<CorrectionProposal> = {}): CorrectionProposal {
  return {
    start: 16,
    end: 25,
    original: 'metfromin',
    proposed: 'metformin',
    category: 'drugName',
    confidence: 0.93,
    rationale: 'misspelling of metformin',
    detectedBy: 'nlp.ner',
    proposedBy: 'lmstudio:hope-scribe',
    status: 'PROPOSED',
    ...overrides,
  };
}

describe('verifiedProposals', () => {
  it('keeps a proposal whose offsets slice out exactly its own `original`', () => {
    expect(verifiedProposals(TEXT, [proposal()])).toHaveLength(1);
  });

  it('DROPS a proposal whose offsets do not match its own `original`', () => {
    expect(verifiedProposals(TEXT, [proposal({ start: 15, end: 24 })])).toEqual([]);
  });

  it('drops a proposal that would be a no-op', () => {
    expect(verifiedProposals(TEXT, [proposal({ proposed: 'metfromin' })])).toEqual([]);
  });

  it('drops out-of-range and inverted spans', () => {
    expect(verifiedProposals(TEXT, [proposal({ start: -1 }), proposal({ start: 30, end: 10 }), proposal({ end: 9999 })])).toEqual([]);
  });

  it('drops a proposal already marked applied — an applied change is not a proposal', () => {
    expect(verifiedProposals(TEXT, [proposal({ status: 'ACCEPTED' })])).toEqual([]);
  });
});

describe('applyProposal', () => {
  it('splices the replacement at the proposal offsets and changes nothing else', () => {
    const result = applyProposal(TEXT, proposal(), [proposal()]);
    expect(result.text).toBe('Patient started metformin 500mg and lisinopril 10mg.');
  });

  it('RE-VERIFIES the remaining proposals against the NEW text after a length-changing accept', () => {
    // "lisinopril" -> "Lisinopril" sits after the first edit. The first accept is one char
    // shorter ("metfromin" 9 -> "metformin" 9 is same length), so use a shortening edit.
    const shorten = proposal({ original: 'metfromin 500mg', end: 31, proposed: 'metformin 500 mg' });
    const later = proposal({ start: 36, end: 46, original: 'lisinopril', proposed: 'Lisinopril', category: 'medicalTerm' });

    const result = applyProposal(TEXT, shorten, [shorten, later]);

    // Non-vacuous: the later proposal SURVIVES this edit, so there is something to check.
    expect(result.remaining).toHaveLength(1);
    // Its offsets moved with the text — it is not left pointing at its stale ones.
    expect(result.remaining[0].start).toBe(later.start + 1);
    for (const remaining of result.remaining) {
      expect(result.text.slice(remaining.start, remaining.end)).toBe(remaining.original);
    }
  });

  it('drops a remaining proposal that no longer verifies after the accept, rather than adjusting it blindly', () => {
    const first = proposal({ start: 16, end: 25, original: 'metfromin', proposed: 'X' });
    // Overlaps the region the first accept rewrote — it cannot survive.
    const overlapping = proposal({ start: 20, end: 25, original: 'romin', proposed: 'rmin' });

    const result = applyProposal(TEXT, first, [first, overlapping]);
    expect(result.remaining).toEqual([]);
  });

  it('removes the accepted proposal from the remaining set', () => {
    const accepted = proposal();
    const other = proposal({ start: 36, end: 46, original: 'lisinopril', proposed: 'Lisinopril' });
    const result = applyProposal(TEXT, accepted, [accepted, other]);

    expect(result.remaining.some((item) => item.original === 'metfromin')).toBe(false);
  });

  it('refuses to apply a proposal that does not verify against the text it was handed', () => {
    expect(() => applyProposal(TEXT, proposal({ start: 15, end: 24 }), [])).toThrow(/does not match/i);
  });
});
