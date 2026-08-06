import { describe, expect, it } from 'vitest';
import { AiCapability, AiDeploymentKind } from '@arcaai/domains';

import { buildNerUsageEvent } from '../nerUsageEvent';

describe('buildNerUsageEvent (TASK-615 WS-E, revised — per-invocation keying)', () => {
  it('builds TEXT_UNIT + REQUEST units keyed to the invocation, with consultationId as attribution', () => {
    const event = buildNerUsageEvent({
      tenantId: 't1',
      requestId: 'job-a',
      consultationId: 'consult-1',
      charCount: 250,
      model: 'blaze999/Medical-NER',
    });

    expect(event.common).toMatchObject({
      tenantId: 't1',
      idempotencyKey: 'nlp:job-a',
      capability: AiCapability.NLP,
      operation: 'ner.extract',
      provider: 'built-in',
      model: 'blaze999/Medical-NER',
      deployment: AiDeploymentKind.SELF_HOSTED,
      consultationId: 'consult-1',
      requestId: 'job-a',
    });
    expect(event.units).toEqual([
      { unit: 'TEXT_UNIT', quantity: 2.5 },
      { unit: 'REQUEST', quantity: 1 },
    ]);
  });

  // The load-bearing regression test: two NER invocations for the SAME
  // consultation must NEVER collapse onto one ledger row. An earlier version
  // of this helper keyed on consultationId alone, which made every call
  // after the first a silent no-op at the drainer's idempotency dedup — real
  // usage, zero record. "Consultation-batched" governs the CALL PATTERN
  // (bigger inputs, fewer calls), not billing identity.
  it('two invocations for the SAME consultation get DISTINCT key sets and each keeps its OWN quantities', () => {
    const first = buildNerUsageEvent({ tenantId: 't1', requestId: 'job-a', consultationId: 'shared-consult', charCount: 100, model: 'm1' });
    const second = buildNerUsageEvent({ tenantId: 't1', requestId: 'job-b', consultationId: 'shared-consult', charCount: 400, model: 'm1' });

    // Distinct identity — never dropped as a "duplicate".
    expect(first.common.idempotencyKey).not.toBe(second.common.idempotencyKey);
    expect(first.common.idempotencyKey).toBe('nlp:job-a');
    expect(second.common.idempotencyKey).toBe('nlp:job-b');

    // Same attribution — both belong to the same consultation for rollups.
    expect(first.common.consultationId).toBe('shared-consult');
    expect(second.common.consultationId).toBe('shared-consult');

    // Each call's OWN quantity survives — nothing summed away or dropped.
    expect(first.units).toEqual([
      { unit: 'TEXT_UNIT', quantity: 1 },
      { unit: 'REQUEST', quantity: 1 },
    ]);
    expect(second.units).toEqual([
      { unit: 'TEXT_UNIT', quantity: 4 },
      { unit: 'REQUEST', quantity: 1 },
    ]);
  });

  it('two invocations with the SAME requestId (a genuine retry) DO share an idempotencyKey', () => {
    // Retry-safety is preserved: the key is a pure function of requestId.
    const a = buildNerUsageEvent({ tenantId: 't1', requestId: 'job-retry-1', consultationId: 'consult-1', charCount: 100, model: null });
    const b = buildNerUsageEvent({ tenantId: 't1', requestId: 'job-retry-1', consultationId: 'consult-1', charCount: 100, model: null });
    expect(a.common.idempotencyKey).toBe(b.common.idempotencyKey);
  });

  it('carries a null model when the AiTaskDefault resolution was fail-open (unknown, not guessed)', () => {
    const event = buildNerUsageEvent({ tenantId: 't1', requestId: 'job-a', consultationId: 'consult-1', charCount: 100, model: null });
    expect(event.common.model).toBeNull();
  });

  it('rejects a blank requestId (would collapse every invocation onto one key)', () => {
    expect(() => buildNerUsageEvent({ tenantId: 't1', requestId: '', consultationId: 'consult-1', charCount: 100, model: null })).toThrow();
  });

  // TASK-615 WS-D2 (item 2) — the playground `/ai/nlp/entities` call site has
  // NO consultation context at all (a standalone inference proxy, not a
  // consultation write path), so consultationId must be optional; doctorId is
  // new attribution for that same call site (a clinician using the tool
  // under their own account).
  describe('optional consultationId + doctorId attribution (TASK-615 WS-D2)', () => {
    it('omits consultationId entirely when the call carries none (playground path)', () => {
      const event = buildNerUsageEvent({ tenantId: 't1', requestId: 'req-1', charCount: 100, model: 'm1' });
      expect(event.common.consultationId).toBeNull();
    });

    it('carries doctorId when the caller supplies one, without requiring consultationId', () => {
      const event = buildNerUsageEvent({ tenantId: 't1', requestId: 'req-1', charCount: 100, model: 'm1', doctorId: 'doctor-9' });
      expect(event.common.doctorId).toBe('doctor-9');
      expect(event.common.consultationId).toBeNull();
    });

    it('omits doctorId when the caller supplies none (non-clinician playground user)', () => {
      const event = buildNerUsageEvent({ tenantId: 't1', requestId: 'req-1', charCount: 100, model: 'm1' });
      expect(event.common.doctorId).toBeNull();
    });

    it('the two existing consultation call sites (ner.processor / summary.service) are unaffected — consultationId still required-shaped when supplied', () => {
      const event = buildNerUsageEvent({ tenantId: 't1', requestId: 'job-a', consultationId: 'consult-1', charCount: 250, model: 'm1' });
      expect(event.common.consultationId).toBe('consult-1');
      expect(event.common.doctorId).toBeNull();
    });
  });
});
