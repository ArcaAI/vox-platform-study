/**
 * TASK-959 — `appendComputeAndByteUnits`, the ONE place occupancy seconds and
 * third-party bytes become ledger rows.
 *
 * Five things are pinned here because each one is a WRONG INVOICE if it slips:
 *
 *  1. `device` decides the UNIT, and the two units are priced an order of
 *     magnitude apart. `cuda`/`mps` → `GPU_SECOND`, `cpu` → `CPU_SECOND`.
 *  2. An absent — or unrecognised — device on a SELF_HOSTED call records NO
 *     compute row. Guessing is the DEVICE RESOLVER's job, not this function's:
 *     a caller that resolved nothing measured nothing.
 *  3. A CLOUD or BYOK call is metered on the PLATFORM's own CPU (the seconds
 *     spent calling the vendor), never on a device the vendor owns — and on a
 *     BYOK_NOTIONAL batch that row is `INTERNAL`, the one sanctioned
 *     mixed-basis case. A CLOUD batch is already INTERNAL and needs no split.
 *  4. Bytes are appended only when actually observed. A `0` that means "the
 *     adapter reported nothing" is not a measurement, and a zero-quantity row
 *     is dropped by the batch expansion anyway.
 *  5. `device` and `byteSource` ride the UNIT ROW's own attributes, so the
 *     token / audio / character rows an emitter already wrote are untouched,
 *     and every quantity is a DECIMAL STRING — a price multiplied by an IEEE
 *     double is where drift becomes money.
 */

import { describe, expect, it } from 'vitest';
import { AiCapability, AiCostBasis, AiDeploymentKind, AiUsageUnit } from '@arcaai/domains';

import { appendComputeAndByteUnits } from '../compute-units';
import type { UsageEventBatchInput } from '../dto';

const TENANT = '50000000-0000-0000-0000-000000000000';

function batchOf(overrides: Partial<UsageEventBatchInput['common']> = {}): UsageEventBatchInput {
  return {
    common: {
      tenantId: TENANT,
      idempotencyKey: 'llm:task-1',
      occurredAt: new Date('2026-09-12T10:00:00.000Z'),
      capability: AiCapability.LLM,
      operation: 'generate',
      provider: 'lm-studio',
      model: 'qwen3-32b',
      deployment: AiDeploymentKind.SELF_HOSTED,
      requestId: 'task-1',
      attributesJson: { endpointKind: 'openai.chat', interrupted: false },
      ...overrides,
    },
    units: [
      { unit: AiUsageUnit.INPUT_TOKEN, quantity: 100 },
      { unit: AiUsageUnit.OUTPUT_TOKEN, quantity: 20 },
    ],
  };
}

const unitOf = (batch: UsageEventBatchInput, unit: AiUsageUnit) => batch.units.find((line) => line.unit === unit);

describe('appendComputeAndByteUnits — the device decides the unit', () => {
  it('records a cuda self-hosted call as GPU_SECOND', () => {
    const { batch, platformBatch } = appendComputeAndByteUnits(batchOf(), { device: 'cuda', totalMs: 2500 });

    expect(unitOf(batch, AiUsageUnit.GPU_SECOND)).toEqual({
      unit: AiUsageUnit.GPU_SECOND,
      quantity: '2.500',
      attributesJson: { device: 'cuda' },
    });
    expect(unitOf(batch, AiUsageUnit.CPU_SECOND)).toBeUndefined();
    expect(platformBatch).toBeUndefined();
  });

  it('records an mps self-hosted call as GPU_SECOND too', () => {
    const { batch } = appendComputeAndByteUnits(batchOf(), { device: 'mps', totalMs: 1000 });
    expect(unitOf(batch, AiUsageUnit.GPU_SECOND)?.quantity).toBe('1.000');
  });

  it('records a cpu self-hosted call as CPU_SECOND', () => {
    const { batch } = appendComputeAndByteUnits(batchOf({ provider: 'llama-cpp' }), { device: 'cpu', totalMs: 750 });
    expect(unitOf(batch, AiUsageUnit.CPU_SECOND)?.quantity).toBe('0.750');
    expect(unitOf(batch, AiUsageUnit.GPU_SECOND)).toBeUndefined();
  });

  it('prefers the ENGINE clock over the client wall clock when the engine reported one', () => {
    const { batch } = appendComputeAndByteUnits(batchOf(), { device: 'cuda', totalMs: 2500, engineMs: 1800 });
    expect(unitOf(batch, AiUsageUnit.GPU_SECOND)?.quantity).toBe('1.800');
  });

  it('falls through a ZERO engine clock to the wall clock — an engine that reported nothing did not run in no time', () => {
    const { batch } = appendComputeAndByteUnits(batchOf(), { device: 'cuda', totalMs: 2500, engineMs: 0 });
    expect(unitOf(batch, AiUsageUnit.GPU_SECOND)?.quantity).toBe('2.500');
  });

  it('accepts seconds from a service that measures in seconds — stt reports `processing_seconds`', () => {
    const { batch } = appendComputeAndByteUnits(batchOf({ provider: 'whisper_cpp' }), { device: 'cuda', seconds: 11.2504 });
    expect(unitOf(batch, AiUsageUnit.GPU_SECOND)?.quantity).toBe('11.250');
  });

  it('keeps three decimals, so a sub-millisecond activity is not rounded to nothing', () => {
    const { batch } = appendComputeAndByteUnits(batchOf(), { device: 'cpu', totalMs: 1.25 });
    expect(unitOf(batch, AiUsageUnit.CPU_SECOND)?.quantity).toBe('0.001');
  });

  it('records nothing for a reading that rounds away — that is a non-event, not a free second', () => {
    const { batch } = appendComputeAndByteUnits(batchOf(), { device: 'cpu', totalMs: 0.0004 });
    expect(batch.units).toHaveLength(2);
  });

  it('appends nothing when neither clock was reported', () => {
    const { batch } = appendComputeAndByteUnits(batchOf(), { device: 'cuda' });
    expect(batch.units).toHaveLength(2);
  });

  it('records NO compute row when nobody resolved a device for a self-hosted call', () => {
    // The two units are priced an order of magnitude apart, so the fallback is
    // not a cheaper unit — it is no unit. `IComputeDeviceResolver` is what
    // answers `cpu` for an unlisted provider; a caller that passed nothing here
    // asked no one.
    const { batch, platformBatch } = appendComputeAndByteUnits(batchOf(), { totalMs: 1000 });
    expect(batch.units).toHaveLength(2);
    expect(platformBatch).toBeUndefined();
  });

  it('records NO compute row for a device spelling the ledger does not price', () => {
    // Two of the three reporting paths read an UNVALIDATED wire body. A `gpu`
    // must not become a GPU_SECOND by string luck, nor a CPU_SECOND by falling
    // through: `validateUsageAttributes` would reject it at emit time and take
    // the whole batch — tokens included — with it.
    const { batch } = appendComputeAndByteUnits(batchOf(), { device: 'gpu', seconds: 4 });
    expect(batch.units).toHaveLength(2);
  });

  it('leaves the rows the emitter already wrote byte-identical — the attributes ride the new row only', () => {
    const { batch } = appendComputeAndByteUnits(batchOf(), { device: 'cuda', totalMs: 1000, responseBytes: 512, byteSource: 'wire' });

    expect(batch.units.slice(0, 2)).toEqual([
      { unit: AiUsageUnit.INPUT_TOKEN, quantity: 100 },
      { unit: AiUsageUnit.OUTPUT_TOKEN, quantity: 20 },
    ]);
    expect(batch.common.attributesJson).toEqual({ endpointKind: 'openai.chat', interrupted: false });
  });
});

describe('appendComputeAndByteUnits — a third-party call is the PLATFORM occupying its own CPU', () => {
  it('ignores the reported device on a CLOUD batch and records CPU_SECOND', () => {
    const { batch, platformBatch } = appendComputeAndByteUnits(
      batchOf({ deployment: AiDeploymentKind.CLOUD, provider: 'anthropic', costBasis: AiCostBasis.INTERNAL }),
      // A caller that wrongly resolved `cuda` for a vendor must not bill a GPU second.
      { device: 'cuda', totalMs: 3000 },
    );

    expect(unitOf(batch, AiUsageUnit.CPU_SECOND)).toEqual({
      unit: AiUsageUnit.CPU_SECOND,
      quantity: '3.000',
      attributesJson: { device: 'cpu' },
    });
    expect(unitOf(batch, AiUsageUnit.GPU_SECOND)).toBeUndefined();
    // Same cost basis on both halves — no split is needed, so none is made.
    expect(platformBatch).toBeUndefined();
  });

  it('meters a CLOUD call that reported no device at all — the platform CPU is not the vendor’s to report', () => {
    const { batch } = appendComputeAndByteUnits(batchOf({ deployment: AiDeploymentKind.CLOUD, provider: 'azure' }), { totalMs: 2000 });
    expect(unitOf(batch, AiUsageUnit.CPU_SECOND)?.quantity).toBe('2.000');
  });

  it('splits a BYOK batch: the tokens stay BYOK_NOTIONAL, the platform CPU is INTERNAL', () => {
    const { batch, platformBatch } = appendComputeAndByteUnits(
      batchOf({ deployment: AiDeploymentKind.BYOK, provider: 'openai', costBasis: AiCostBasis.BYOK_NOTIONAL }),
      { totalMs: 4200 },
    );

    // The tenant's own tokens are untouched and still notional.
    expect(batch.units.map((line) => line.unit)).toEqual([AiUsageUnit.INPUT_TOKEN, AiUsageUnit.OUTPUT_TOKEN]);
    expect(batch.common.costBasis).toBe(AiCostBasis.BYOK_NOTIONAL);

    expect(platformBatch).toBeDefined();
    expect(platformBatch?.common.costBasis).toBe(AiCostBasis.INTERNAL);
    expect(platformBatch?.common.deployment).toBe(AiDeploymentKind.BYOK);
    expect(platformBatch?.units).toEqual([{ unit: AiUsageUnit.CPU_SECOND, quantity: '4.200', attributesJson: { device: 'cpu' } }]);
  });

  it('gives the platform batch the SAME base key, so the two never collide and never diverge', () => {
    const { batch, platformBatch } = appendComputeAndByteUnits(batchOf({ deployment: AiDeploymentKind.BYOK, costBasis: AiCostBasis.BYOK_NOTIONAL }), {
      totalMs: 1000,
    });
    // Expansion appends `:<UNIT>`, and CPU_SECOND appears in exactly one of the
    // two batches — so one base key yields disjoint row keys.
    expect(platformBatch?.common.idempotencyKey).toBe(batch.common.idempotencyKey);
  });

  it('splits nothing when there is no compute row to split', () => {
    const { batch, platformBatch } = appendComputeAndByteUnits(batchOf({ deployment: AiDeploymentKind.BYOK, costBasis: AiCostBasis.BYOK_NOTIONAL }), {
      requestBytes: 2048,
      byteSource: 'wire',
    });
    expect(platformBatch).toBeUndefined();
    expect(unitOf(batch, AiUsageUnit.EGRESS_BYTE)?.quantity).toBe('2048');
  });
});

describe('appendComputeAndByteUnits — bytes are recorded only when observed', () => {
  it('maps request bytes to EGRESS and response bytes to INGRESS', () => {
    const { batch } = appendComputeAndByteUnits(batchOf({ deployment: AiDeploymentKind.CLOUD, provider: 'openai' }), {
      totalMs: 1000,
      requestBytes: 4096,
      responseBytes: 8192,
      byteSource: 'wire',
    });

    expect(unitOf(batch, AiUsageUnit.EGRESS_BYTE)).toEqual({
      unit: AiUsageUnit.EGRESS_BYTE,
      quantity: '4096',
      attributesJson: { byteSource: 'wire' },
    });
    expect(unitOf(batch, AiUsageUnit.INGRESS_BYTE)).toEqual({
      unit: AiUsageUnit.INGRESS_BYTE,
      quantity: '8192',
      attributesJson: { byteSource: 'wire' },
    });
  });

  it('appends no byte row — and no byteSource — when the adapter reported none', () => {
    const { batch } = appendComputeAndByteUnits(batchOf(), { device: 'cuda', totalMs: 1000, requestBytes: null, responseBytes: null });
    expect(unitOf(batch, AiUsageUnit.EGRESS_BYTE)).toBeUndefined();
    expect(unitOf(batch, AiUsageUnit.INGRESS_BYTE)).toBeUndefined();
  });

  it('treats a reported ZERO as "nothing observed", never as a measurement', () => {
    const { batch } = appendComputeAndByteUnits(batchOf(), { device: 'cuda', totalMs: 1000, requestBytes: 0, responseBytes: 0, byteSource: 'app' });
    expect(unitOf(batch, AiUsageUnit.EGRESS_BYTE)).toBeUndefined();
    expect(unitOf(batch, AiUsageUnit.INGRESS_BYTE)).toBeUndefined();
  });

  it('records one direction when only one is observable (a streamed response body, say)', () => {
    const { batch } = appendComputeAndByteUnits(batchOf({ deployment: AiDeploymentKind.CLOUD, provider: 'bedrock' }), {
      totalMs: 500,
      requestBytes: 2048,
      responseBytes: null,
      byteSource: 'wire',
    });
    expect(unitOf(batch, AiUsageUnit.EGRESS_BYTE)?.quantity).toBe('2048');
    expect(unitOf(batch, AiUsageUnit.INGRESS_BYTE)).toBeUndefined();
  });

  it('drops a byteSource the ledger does not know, and keeps the count', () => {
    const { batch } = appendComputeAndByteUnits(batchOf({ deployment: AiDeploymentKind.CLOUD }), { responseBytes: 64, byteSource: 'guess' });
    expect(unitOf(batch, AiUsageUnit.INGRESS_BYTE)).toEqual({ unit: AiUsageUnit.INGRESS_BYTE, quantity: '64' });
  });

  it('leaves bytes on the tenant batch when a BYOK compute row splits off', () => {
    const { batch, platformBatch } = appendComputeAndByteUnits(batchOf({ deployment: AiDeploymentKind.BYOK, costBasis: AiCostBasis.BYOK_NOTIONAL }), {
      totalMs: 1000,
      requestBytes: 10,
      responseBytes: 20,
      byteSource: 'wire',
    });
    expect(unitOf(batch, AiUsageUnit.EGRESS_BYTE)?.quantity).toBe('10');
    expect(platformBatch?.units.map((line) => line.unit)).toEqual([AiUsageUnit.CPU_SECOND]);
  });
});

describe('appendComputeAndByteUnits — it never mutates what it was handed', () => {
  it('returns a new batch and leaves the caller’s own copy alone', () => {
    const original = batchOf();
    const { batch } = appendComputeAndByteUnits(original, { device: 'cuda', totalMs: 1000, responseBytes: 8 });

    expect(original.units).toHaveLength(2);
    expect(original.common.attributesJson).toEqual({ endpointKind: 'openai.chat', interrupted: false });
    expect(batch).not.toBe(original);
    expect(batch.units).not.toBe(original.units);
  });
});
