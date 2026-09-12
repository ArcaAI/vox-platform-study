/**
 * TASK-959 §2.1 / §10.2 — appending compute and byte unit rows to a batch that already exists.
 *
 * The design principle this pins is "no new grain, new units": a call's GPU/CPU occupancy and
 * its vendor bytes are MORE UNIT ROWS on the batch the call already writes, sharing its base
 * idempotency key (expansion appends `:<UNIT>`), never a second event shape.
 *
 * The one structural exception is cost basis. A batch carries ONE `costBasis`, and on a BYOK
 * call the tokens are the tenant's money while the CPU seconds spent CALLING the vendor are the
 * platform's. That row therefore leaves as a SECOND batch at `INTERNAL`, sharing the base key —
 * the single sanctioned mixed-basis case in the contract.
 */
import { describe, expect, it } from 'vitest';
import { AiCapability, AiCostBasis, AiDeploymentKind, AiUsageUnit } from '@arcaai/domains';
import type { UsageEventBatchInput } from '@arcaai/applications';
import { appendComputeAndByteUnits } from '../compute-units';

const batch = (over: Partial<UsageEventBatchInput['common']> = {}): UsageEventBatchInput => ({
  common: {
    tenantId: 't1',
    idempotencyKey: 'llm:task-1',
    occurredAt: new Date('2026-09-12T10:00:00.000Z'),
    capability: AiCapability.LLM,
    operation: 'generate',
    provider: 'lm-studio',
    model: 'gemma-3',
    deployment: AiDeploymentKind.SELF_HOSTED,
    costBasis: AiCostBasis.INTERNAL,
    requestId: 'task-1',
    ...over,
  },
  units: [{ unit: AiUsageUnit.INPUT_TOKEN, quantity: 120 }],
});

const unitsOf = (batches: UsageEventBatchInput[], index = 0) => batches[index]?.units ?? [];
const unit = (batches: UsageEventBatchInput[], u: AiUsageUnit, index = 0) => unitsOf(batches, index).find((line) => line.unit === u);

describe('appendComputeAndByteUnits — the compute row', () => {
  it('records a GPU_SECOND for cuda, quantity in seconds to 3 decimal places', () => {
    const result = appendComputeAndByteUnits(batch(), { device: 'cuda', seconds: 2.1004 });

    expect(result).toHaveLength(1);
    expect(unit(result, AiUsageUnit.GPU_SECOND)).toMatchObject({ quantity: 2.1, attributesJson: { device: 'cuda' } });
    // The row it was appended to is untouched — compute never displaces tokens.
    expect(unit(result, AiUsageUnit.INPUT_TOKEN)).toMatchObject({ quantity: 120 });
  });

  it('records a GPU_SECOND for mps and a CPU_SECOND for cpu — the device decides the unit, not the price', () => {
    expect(unit(appendComputeAndByteUnits(batch(), { device: 'mps', seconds: 1 }), AiUsageUnit.GPU_SECOND)).toBeDefined();
    expect(unit(appendComputeAndByteUnits(batch(), { device: 'cpu', seconds: 1 }), AiUsageUnit.CPU_SECOND)).toBeDefined();
  });

  it('records NOTHING when the device is unknown — a guessed device is a guessed price', () => {
    const result = appendComputeAndByteUnits(batch(), { device: null, seconds: 9 });

    expect(unitsOf(result)).toHaveLength(1);
    expect(unitsOf(result)[0]?.unit).toBe(AiUsageUnit.INPUT_TOKEN);
  });

  it('records nothing when the seconds are absent, zero, or round to zero at 3 dp', () => {
    for (const seconds of [null, 0, 0.0004, -1]) {
      const result = appendComputeAndByteUnits(batch(), { device: 'cuda', seconds });
      expect(unit(result, AiUsageUnit.GPU_SECOND)).toBeUndefined();
    }
  });

  it('leaves the batch exactly as it was when there is nothing to append', () => {
    const input = batch();
    const result = appendComputeAndByteUnits(input, { device: null, seconds: null });

    expect(result).toEqual([input]);
  });

  it('answers an empty list for a null batch — nothing was consumed, so nothing is recorded', () => {
    expect(appendComputeAndByteUnits(null, { device: 'cuda', seconds: 5 })).toEqual([]);
  });

  it('never mutates the batch it was handed (an abort path may build once and emit twice)', () => {
    const input = batch();
    appendComputeAndByteUnits(input, { device: 'cuda', seconds: 3, responseBytes: 10 });

    expect(input.units).toHaveLength(1);
  });
});

describe('appendComputeAndByteUnits — the byte rows', () => {
  it('records EGRESS for what went out and INGRESS for what came back, with the byte source', () => {
    const result = appendComputeAndByteUnits(batch(), { device: null, seconds: null, requestBytes: 4096, responseBytes: 8192, byteSource: 'wire' });

    expect(unit(result, AiUsageUnit.EGRESS_BYTE)).toMatchObject({ quantity: 4096, attributesJson: { byteSource: 'wire' } });
    expect(unit(result, AiUsageUnit.INGRESS_BYTE)).toMatchObject({ quantity: 8192, attributesJson: { byteSource: 'wire' } });
  });

  it('omits a direction that measured nothing — `null` is "not counted", 0 is "counted nothing"', () => {
    const result = appendComputeAndByteUnits(batch(), { device: null, seconds: null, requestBytes: null, responseBytes: 0 });

    expect(unit(result, AiUsageUnit.EGRESS_BYTE)).toBeUndefined();
    expect(unit(result, AiUsageUnit.INGRESS_BYTE)).toBeUndefined();
  });

  it('omits `byteSource` when the counter did not say how it counted', () => {
    const result = appendComputeAndByteUnits(batch(), { device: null, seconds: null, responseBytes: 512 });

    expect(unit(result, AiUsageUnit.INGRESS_BYTE)?.attributesJson).toBeUndefined();
  });
});

describe('appendComputeAndByteUnits — the one sanctioned mixed-basis case', () => {
  const byok = () =>
    batch({ deployment: AiDeploymentKind.BYOK, costBasis: AiCostBasis.BYOK_NOTIONAL, provider: 'openai', idempotencyKey: 'llm:task-9' });

  it('splits the CPU row off a BYOK batch as a SECOND batch at INTERNAL, sharing the base key', () => {
    const result = appendComputeAndByteUnits(byok(), { device: 'cpu', seconds: 1.25, responseBytes: 2048, byteSource: 'wire' });

    expect(result).toHaveLength(2);
    // The tenant's money: tokens and the bytes of the call they paid for.
    expect(result[0]?.common.costBasis).toBe(AiCostBasis.BYOK_NOTIONAL);
    expect(unit(result, AiUsageUnit.CPU_SECOND, 0)).toBeUndefined();
    expect(unit(result, AiUsageUnit.INGRESS_BYTE, 0)).toBeDefined();
    // The platform's money: the CPU it burned making the call.
    expect(result[1]?.common.costBasis).toBe(AiCostBasis.INTERNAL);
    expect(result[1]?.common.idempotencyKey).toBe('llm:task-9');
    expect(result[1]?.units).toEqual([{ unit: AiUsageUnit.CPU_SECOND, quantity: 1.25, attributesJson: { device: 'cpu' } }]);
  });

  it('keeps every OTHER attribution identical on the split batch — it is the same call', () => {
    const result = appendComputeAndByteUnits(byok(), { device: 'cpu', seconds: 2 });

    expect(result[1]?.common).toMatchObject({
      tenantId: 't1',
      requestId: 'task-1',
      provider: 'openai',
      deployment: AiDeploymentKind.BYOK,
      capability: AiCapability.LLM,
      operation: 'generate',
    });
  });

  it('does NOT split a CLOUD call — the platform paid for both halves, so one basis covers them', () => {
    const cloud = batch({ deployment: AiDeploymentKind.CLOUD, costBasis: AiCostBasis.INTERNAL, provider: 'openai' });
    const result = appendComputeAndByteUnits(cloud, { device: 'cpu', seconds: 3 });

    expect(result).toHaveLength(1);
    expect(unit(result, AiUsageUnit.CPU_SECOND)).toMatchObject({ quantity: 3 });
  });
});
