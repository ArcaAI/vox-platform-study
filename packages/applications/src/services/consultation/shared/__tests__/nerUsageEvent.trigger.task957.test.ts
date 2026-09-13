/**
 * TASK-957 F-8 — `ner.extract` must say WHICH activity caused it.
 *
 * Three call sites share this builder and they are three different activities:
 * the agent NER route (`AGENT_INVOCATION`), the playground `/ai/nlp/entities`
 * bench, and the clinical `extractEntities` hop (`CONSULTATION`). Until now the
 * builder had nowhere to put the answer, so the agent route wrapped its batch in
 * `withUsageTrigger` afterwards and the clinical hop recorded nothing at all —
 * which is exactly the hole that makes "spend by activity" incomplete.
 *
 * The parameter is OPTIONAL on purpose. A caller that genuinely does not know
 * its own trigger must be able to say so; a default would put a guess on a
 * billing dimension, and `trigger` is a closed vocabulary precisely because a
 * wrong value forks a rollup silently rather than failing.
 */
import { describe, expect, it } from 'vitest';

import { validateUsageAttributes } from '../../../usageLedger/usage-attributes';
import { buildNerUsageEvent } from '../nerUsageEvent';

const base = { tenantId: 't1', requestId: 'req-1', charCount: 250, model: 'medical-ner' };

describe('buildNerUsageEvent — trigger (TASK-957 F-8)', () => {
  it('stamps the caller-declared trigger onto attributesJson', () => {
    const event = buildNerUsageEvent({ ...base, trigger: 'CONSULTATION' });

    expect(event.common.attributesJson?.trigger).toBe('CONSULTATION');
    expect(validateUsageAttributes(event.common.attributesJson)).toEqual([]);
  });

  it('leaves the bag byte-identical when the caller declares none', () => {
    const event = buildNerUsageEvent(base);

    expect(event.common.attributesJson?.trigger).toBeUndefined();
  });

  it('does not disturb the units or the per-invocation key', () => {
    const withTrigger = buildNerUsageEvent({ ...base, trigger: 'AGENT_INVOCATION' });
    const without = buildNerUsageEvent(base);

    expect(withTrigger.units).toEqual(without.units);
    expect(withTrigger.common.idempotencyKey).toBe(without.common.idempotencyKey);
  });
});
