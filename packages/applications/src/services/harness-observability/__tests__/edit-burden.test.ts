/**
 * Edit-burden telemetry — pure-function unit tests.
 *
 * The clinician gate already emits approve/edit decisions + delivered-vs-signed
 * note versions into the WORM audit; nothing derived edit-burden from it (S3-F7
 * "signal exists in the gate, unused"). These are the pure derivations:
 *   - word-level edit distance between the delivered and signed note,
 *   - deferral rate over the gate-decision sequence,
 *   - time-to-sign from two timestamps.
 * All are arithmetic over already-persisted values — no PHI leaves in the output
 * (only scalars), no capture, no workflow change.
 */
import { describe, expect, it } from 'vitest';
import {
  computeEditBurden,
  deferralRate,
  timeToSignSeconds,
  wordLevelEditDistance,
} from '../edit-burden';

describe('wordLevelEditDistance', () => {
  it('is zero for identical text', () => {
    expect(wordLevelEditDistance('continue lisinopril 10 mg daily', 'continue lisinopril 10 mg daily')).toBe(0);
  });

  it('counts a single word substitution as distance 1', () => {
    expect(wordLevelEditDistance('lisinopril 10 mg daily', 'lisinopril 20 mg daily')).toBe(1);
  });

  it('counts an inserted word as distance 1', () => {
    expect(wordLevelEditDistance('continue metformin', 'continue metformin daily')).toBe(1);
  });

  it('counts a deleted word as distance 1', () => {
    expect(wordLevelEditDistance('continue metformin 1000 mg', 'continue metformin mg')).toBe(1);
  });

  it('is word-level, not character-level (whitespace-insensitive)', () => {
    // Two words changed → distance 2, regardless of character counts.
    expect(wordLevelEditDistance('start atorvastatin', 'stop simvastatin')).toBe(2);
  });

  it('equals the token count when one side is empty', () => {
    expect(wordLevelEditDistance('', 'a b c')).toBe(3);
    expect(wordLevelEditDistance('a b c d', '')).toBe(4);
  });
});

describe('deferralRate', () => {
  it('is zero when every gate decision is a clean pass', () => {
    const r = deferralRate(['PASS', 'PASS', 'APPROVE']);
    expect(r.total).toBe(3);
    expect(r.deferrals).toBe(0);
    expect(r.rate).toBe(0);
  });

  it('counts FLAG / REGEN / escalation as deferrals', () => {
    const r = deferralRate(['PASS', 'FLAG', 'REGEN', 'ESCALATED']);
    expect(r.total).toBe(4);
    expect(r.deferrals).toBe(3);
    expect(r.rate).toBeCloseTo(3 / 4);
  });

  it('is case-insensitive on the clean verdict', () => {
    expect(deferralRate(['pass', 'Approve']).deferrals).toBe(0);
  });
});

describe('timeToSignSeconds', () => {
  it('is the whole-second gap between delivered and signed', () => {
    const delivered = new Date('2026-07-10T10:00:00.000Z');
    const signed = new Date('2026-07-10T11:00:00.000Z');
    expect(timeToSignSeconds(delivered, signed)).toBe(3600);
  });

  it('accepts ISO strings', () => {
    expect(timeToSignSeconds('2026-07-10T10:00:00.000Z', '2026-07-10T10:00:30.000Z')).toBe(30);
  });

  it('is null when either timestamp is missing', () => {
    expect(timeToSignSeconds(new Date(), null)).toBeNull();
    expect(timeToSignSeconds(null, new Date())).toBeNull();
  });

  it('clamps an anomalous signed-before-delivered pair to zero', () => {
    const delivered = new Date('2026-07-10T11:00:00.000Z');
    const signed = new Date('2026-07-10T10:00:00.000Z');
    expect(timeToSignSeconds(delivered, signed)).toBe(0);
  });
});

describe('computeEditBurden', () => {
  it('composes every derived signal from already-persisted values', () => {
    const burden = computeEditBurden({
      deliveredContent: 'continue lisinopril 10 mg daily',
      signedContent: 'continue lisinopril 20 mg daily and start metformin',
      decisions: ['PASS', 'REGEN'],
      deliveredAt: '2026-07-10T10:00:00.000Z',
      signedAt: '2026-07-10T10:05:00.000Z',
    });

    expect(burden.editDistance).toBe(wordLevelEditDistance('continue lisinopril 10 mg daily', 'continue lisinopril 20 mg daily and start metformin'));
    expect(burden.editDistanceRatio).toBeGreaterThan(0);
    expect(burden.gateDecisionTotal).toBe(2);
    expect(burden.deferralCount).toBe(1);
    expect(burden.deferralRate).toBeCloseTo(1 / 2);
    expect(burden.timeToSignSeconds).toBe(300);
    expect(burden.deliveredAt).toBe('2026-07-10T10:00:00.000Z');
    expect(burden.signedAt).toBe('2026-07-10T10:05:00.000Z');
  });

  it('reports null (never a fabricated value) when an input is absent', () => {
    const burden = computeEditBurden({});
    expect(burden.editDistance).toBeNull();
    expect(burden.editDistanceRatio).toBeNull();
    expect(burden.deferralRate).toBeNull();
    expect(burden.gateDecisionTotal).toBe(0);
    expect(burden.deferralCount).toBe(0);
    expect(burden.timeToSignSeconds).toBeNull();
    expect(burden.deliveredAt).toBeNull();
    expect(burden.signedAt).toBeNull();
  });

  it('skips edit distance when only one summary version exists', () => {
    const burden = computeEditBurden({ deliveredContent: 'a note', signedContent: null, decisions: ['PASS'] });
    expect(burden.editDistance).toBeNull();
    expect(burden.editDistanceRatio).toBeNull();
    // Deferral rate is still derivable from the decisions.
    expect(burden.deferralRate).toBe(0);
  });

  it('exposes only derived scalars — never the note text (AC-6)', () => {
    const burden = computeEditBurden({
      deliveredContent: 'PATIENT SECRET diagnosis text',
      signedContent: 'PATIENT SECRET diagnosis text edited',
    });
    const serialized = JSON.stringify(burden);
    expect(serialized).not.toContain('SECRET');
    expect(serialized).not.toContain('diagnosis');
    expect(burden.editDistance).toBe(1);
  });
});
