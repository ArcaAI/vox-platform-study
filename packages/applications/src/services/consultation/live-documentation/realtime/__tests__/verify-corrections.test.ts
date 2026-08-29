/**
 * Lane R (R1) — the proposal-verification safety check.
 *
 * Every case here is a way a model can offer an edit that would splice a replacement over the
 * WRONG characters of clinical text if a console accepted it in one click. The rule under test is
 * that each of them is DROPPED and COUNTED — never repaired, because repairing a mis-specified
 * span would be the platform guessing at an edit to a clinical note.
 */
import { describe, expect, it } from 'vitest';
import { verifyCorrectionProposals } from '../verify-corrections';

const SOURCE = 'patient takes asprin 100mg daily';
const provenance = { provider: 'lmstudio', model: 'test-model' };

/** A proposal that IS correct about its own span, so the negatives below differ by one field. */
function goodProposal(over: Record<string, unknown> = {}) {
  return { start: 14, end: 20, original: 'asprin', proposed: 'aspirin', category: 'spelling', confidence: 0.9, ...over };
}

function verify(proposals: unknown[]) {
  return verifyCorrectionProposals(JSON.stringify({ proposals }), SOURCE, provenance);
}

describe('verifyCorrectionProposals — the span check', () => {
  it('accepts a proposal whose [start,end) really is the text it claims to replace', () => {
    expect(SOURCE.slice(14, 20)).toBe('asprin');
    const { proposals, rejectedProposals } = verify([goodProposal()]);

    expect(rejectedProposals).toBe(0);
    expect(proposals).toHaveLength(1);
    expect(proposals[0]).toMatchObject({
      start: 14,
      end: 20,
      original: 'asprin',
      proposed: 'aspirin',
      category: 'spelling',
      status: 'PROPOSED',
      detectedBy: 'nlp.ner',
      proposedBy: 'lmstudio:test-model',
    });
  });

  it('DROPS a proposal that misreports its own span — the one-click splice hazard', () => {
    // The span points at "takes", but the proposal claims it is "asprin". Accepting this would
    // replace the verb.
    const { proposals, rejectedProposals } = verify([goodProposal({ start: 8, end: 13 })]);
    expect(proposals).toEqual([]);
    expect(rejectedProposals).toBe(1);
  });

  it('DROPS a span that runs past the end of the source', () => {
    expect(verify([goodProposal({ start: 14, end: SOURCE.length + 5 })])).toEqual({ proposals: [], rejectedProposals: 1 });
  });

  it('DROPS an inverted or empty span', () => {
    expect(verify([goodProposal({ start: 20, end: 14 })]).rejectedProposals).toBe(1);
    expect(verify([goodProposal({ start: 14, end: 14 })]).rejectedProposals).toBe(1);
  });

  it('DROPS a negative start', () => {
    expect(verify([goodProposal({ start: -1, end: 6 })]).rejectedProposals).toBe(1);
  });

  it('DROPS an unrecognised category rather than passing it through', () => {
    // The category vocabulary is closed: an unknown one is a malformed proposal, not a feature.
    expect(verify([goodProposal({ category: 'dosage' })]).rejectedProposals).toBe(1);
  });

  it('DROPS a no-op edit', () => {
    expect(verify([goodProposal({ proposed: 'asprin' })]).rejectedProposals).toBe(1);
  });

  it('DROPS non-integer offsets and non-string text', () => {
    expect(verify([goodProposal({ start: 14.5 })]).rejectedProposals).toBe(1);
    expect(verify([goodProposal({ original: 42 })]).rejectedProposals).toBe(1);
    expect(verify(['not an object']).rejectedProposals).toBe(1);
  });

  it('keeps the good ones and counts the bad ones in a mixed batch', () => {
    const { proposals, rejectedProposals } = verify([goodProposal(), goodProposal({ start: 0, end: 7 }), goodProposal({ category: 'nope' })]);
    expect(proposals).toHaveLength(1);
    expect(rejectedProposals).toBe(2);
  });
});

describe('verifyCorrectionProposals — parsing and identity', () => {
  it('tolerates a fenced / prefaced JSON reply', () => {
    const reply = 'Here are the corrections:\n```json\n' + JSON.stringify({ proposals: [goodProposal()] }) + '\n```';
    expect(verifyCorrectionProposals(reply, SOURCE, provenance).proposals).toHaveLength(1);
  });

  it('returns nothing — and does NOT throw — when the model answered in prose', () => {
    expect(verifyCorrectionProposals('I could not find any errors.', SOURCE, provenance)).toEqual({ proposals: [], rejectedProposals: 0 });
  });

  it('gives one proposal a STABLE id across runs, so a retry cannot resurrect a dismissed item', () => {
    const first = verify([goodProposal()]).proposals[0];
    const second = verify([goodProposal()]).proposals[0];
    expect(first.proposalId).toBe(second.proposalId);

    // ...and two genuinely different proposals never collide.
    const other = verify([goodProposal({ proposed: 'Aspirin' })]).proposals[0];
    expect(other.proposalId).not.toBe(first.proposalId);
  });

  it('clamps confidence into [0,1] and defaults a missing rationale rather than dropping the item', () => {
    expect(verify([goodProposal({ confidence: 7 })]).proposals[0].confidence).toBe(1);
    expect(verify([goodProposal({ confidence: -3 })]).proposals[0].confidence).toBe(0);
    expect(verify([goodProposal({ confidence: 'high' })]).proposals[0].confidence).toBe(0);
    expect(verify([goodProposal()]).proposals[0].rationale).toBe('no rationale given');
  });
});
