/**
 * TASK-959 §3.2 — the `ner.extract` row records the compute `apps/nlp` measured.
 *
 * `track_model_inference` has always timed the forward pass into a histogram and returned
 * nothing; since the P-NLP lane it yields its elapsed value and every inference response carries
 * `inference_ms` + `device`. The ledger row carried characters and a request count, so a tenant
 * running a GPU NER checkpoint all month showed no compute at all.
 *
 * The additions are OPTIONAL on purpose: three call sites share this builder (the durable NER
 * job, the synchronous `extractEntities`, the playground proxy) and they adopt the fields as
 * their own paths start carrying them. An omitted reading records no compute row — never a
 * zero-second one, which would read as "measured, and it was free".
 */
import { describe, expect, it } from 'vitest';
import { AiUsageUnit } from '@arcaai/domains';
import { buildNerUsageEvent } from '../nerUsageEvent';

const base = { tenantId: 't1', requestId: 'req-1', charCount: 250, model: 'medical-ner' };
const unit = (event: ReturnType<typeof buildNerUsageEvent>, u: AiUsageUnit) => event.units.find((line) => line.unit === u);

describe('buildNerUsageEvent — compute (TASK-959)', () => {
  it('records GPU seconds for a cuda checkpoint, beside the text units it always recorded', () => {
    const event = buildNerUsageEvent({ ...base, inferenceMs: 420, device: 'cuda' });

    expect(unit(event, AiUsageUnit.GPU_SECOND)).toMatchObject({ quantity: 0.42, attributesJson: { device: 'cuda' } });
    expect(unit(event, AiUsageUnit.TEXT_UNIT)).toMatchObject({ quantity: 2.5 });
    expect(unit(event, AiUsageUnit.REQUEST)).toMatchObject({ quantity: 1 });
  });

  it('records CPU seconds for a cpu checkpoint — the device decides the unit', () => {
    const event = buildNerUsageEvent({ ...base, inferenceMs: 1500, device: 'cpu' });

    expect(unit(event, AiUsageUnit.CPU_SECOND)).toMatchObject({ quantity: 1.5, attributesJson: { device: 'cpu' } });
    expect(unit(event, AiUsageUnit.GPU_SECOND)).toBeUndefined();
  });

  it('records no compute row when either half of the reading is missing', () => {
    expect(unit(buildNerUsageEvent({ ...base, inferenceMs: 420 }), AiUsageUnit.GPU_SECOND)).toBeUndefined();
    expect(unit(buildNerUsageEvent({ ...base, device: 'cuda' }), AiUsageUnit.GPU_SECOND)).toBeUndefined();
    expect(unit(buildNerUsageEvent({ ...base, inferenceMs: 0, device: 'cuda' }), AiUsageUnit.GPU_SECOND)).toBeUndefined();
  });

  it('leaves a caller that passes neither exactly as it was — the three existing call sites', () => {
    const event = buildNerUsageEvent(base);

    expect(event.units).toEqual([
      { unit: AiUsageUnit.TEXT_UNIT, quantity: 2.5 },
      { unit: AiUsageUnit.REQUEST, quantity: 1 },
    ]);
  });

  it('keeps the row self-hosted and internally funded — apps/nlp runs on the platform’s own weights', () => {
    const event = buildNerUsageEvent({ ...base, inferenceMs: 100, device: 'cuda' });

    expect(event.common).toMatchObject({ provider: 'built-in', deployment: 'SELF_HOSTED', operation: 'ner.extract' });
  });
});
