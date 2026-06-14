import { describe, it, expect } from 'vitest';
import { reduceHarnessAssuranceMessage, normalizeHarnessAssuranceEvent } from '../harness-assurance';

// TASK-355 Phase D Slice 6b — per-claim assurance SSE reducer (Q5 true mid-pass live feed).
// Wire format mirrors HarnessAssuranceEventDto: every message is FULL-STATE.

describe('reduceHarnessAssuranceMessage', () => {
  it('treats empty / blank data as a heartbeat', () => {
    expect(reduceHarnessAssuranceMessage('')).toEqual({ kind: 'heartbeat' });
    expect(reduceHarnessAssuranceMessage('   ')).toEqual({ kind: 'heartbeat' });
  });

  it('treats a bare {} and explicit heartbeat payloads as a heartbeat', () => {
    expect(reduceHarnessAssuranceMessage('{}')).toEqual({ kind: 'heartbeat' });
    expect(reduceHarnessAssuranceMessage(JSON.stringify({ type: 'heartbeat', ts: 't' }))).toEqual({ kind: 'heartbeat' });
  });

  it('classifies non-JSON and non-object payloads as invalid', () => {
    expect(reduceHarnessAssuranceMessage('not json')).toEqual({ kind: 'invalid' });
    expect(reduceHarnessAssuranceMessage('123')).toEqual({ kind: 'invalid' });
    expect(reduceHarnessAssuranceMessage('null')).toEqual({ kind: 'invalid' });
  });

  it('classifies a per-claim full-state payload as an event with claims sorted by ordinal', () => {
    const raw = JSON.stringify({
      consultationId: 'c-1',
      jobId: 'j-1',
      total: 3,
      claims: [
        { claimId: 'c-b', sensor: 'groundedness', verdict: 'ungrounded', ordinal: 2, at: 't2' },
        { claimId: 'c-a', sensor: 'groundedness', verdict: 'grounded', ordinal: 1, at: 't1' },
      ],
      updatedAt: 't2',
      closed: false,
    });

    const msg = reduceHarnessAssuranceMessage(raw);

    expect(msg.kind).toBe('event');
    if (msg.kind !== 'event') throw new Error('expected event');
    expect(msg.event.consultationId).toBe('c-1');
    expect(msg.event.total).toBe(3);
    expect(msg.event.claims.map((c) => c.claimId)).toEqual(['c-a', 'c-b']);
    expect(msg.event.claims.map((c) => c.verdict)).toEqual(['grounded', 'ungrounded']);
    expect(msg.event.gateDecision).toBeNull();
    expect(msg.event.safetyFlag).toBe(false);
    expect(msg.event.postSignAlert).toBe(false);
    expect(msg.event.closed).toBe(false);
  });

  it('classifies the terminal assurance_complete payload as closed with the aggregate verdict', () => {
    const raw = JSON.stringify({
      consultationId: 'c-1',
      jobId: 'j-1',
      total: 2,
      claims: [
        { claimId: 'c-a', sensor: 'groundedness', verdict: 'grounded', ordinal: 1, at: 't1' },
        { claimId: 'c-b', sensor: 'groundedness', verdict: 'grounded', ordinal: 2, at: 't2' },
      ],
      gateDecision: 'FLAG',
      safetyFlag: true,
      reducedAssurance: false,
      postSignAlert: true,
      updatedAt: 't3',
      closed: true,
    });

    const msg = reduceHarnessAssuranceMessage(raw);

    expect(msg.kind).toBe('closed');
    if (msg.kind !== 'closed') throw new Error('expected closed');
    expect(msg.event.gateDecision).toBe('FLAG');
    expect(msg.event.safetyFlag).toBe(true);
    expect(msg.event.postSignAlert).toBe(true);
    expect(msg.event.closed).toBe(true);
  });
});

describe('normalizeHarnessAssuranceEvent', () => {
  it('drops malformed claims and de-dupes claimId+sensor (last wins)', () => {
    const event = normalizeHarnessAssuranceEvent({
      consultationId: 'c-1',
      claims: [
        { claimId: 'c-a', sensor: 'groundedness', verdict: 'grounded', ordinal: 1, at: 't1' },
        { sensor: 'groundedness' }, // no claimId → dropped
        { claimId: 'c-a', sensor: 'groundedness', verdict: 'ungrounded', ordinal: 1, at: 't9' }, // dup → last wins
      ],
      updatedAt: 't9',
      closed: false,
    });

    expect(event.claims).toHaveLength(1);
    expect(event.claims[0].verdict).toBe('ungrounded');
  });

  it('coerces missing aggregate fields to safe defaults', () => {
    const event = normalizeHarnessAssuranceEvent({ consultationId: 'c-1', claims: [], updatedAt: 't', closed: true });

    expect(event.gateDecision).toBeNull();
    expect(event.safetyFlag).toBe(false);
    expect(event.reducedAssurance).toBe(false);
    expect(event.postSignAlert).toBe(false);
    expect(event.total).toBeUndefined();
  });
});
