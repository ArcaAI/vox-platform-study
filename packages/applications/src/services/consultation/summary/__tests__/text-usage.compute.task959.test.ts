/**
 * TASK-959 — compute seconds and third-party bytes on the TEXT usage builders.
 *
 * `apps/text` now carries `total_ms`, `engine_ms`, `request_bytes` and
 * `response_bytes` on `usage_detail` (§10.2). This file pins what the gateway
 * does with them, and the two things a reader most needs pinned are the ones
 * that are not obvious from the field names:
 *
 *  - A self-hosted engine's seconds are OCCUPANCY on a device supplied by
 *    configuration; a cloud or BYOK call's seconds are the PLATFORM's own CPU
 *    spent calling the vendor, and on BYOK they are `INTERNAL` while the tokens
 *    beside them stay `BYOK_NOTIONAL`.
 *  - The three long-standing builders keep their single-batch return, so the
 *    six call sites in other lanes compile unchanged. The `*Batches` siblings
 *    are the full-fidelity form and are what a migrated caller uses.
 */

import { describe, expect, it } from 'vitest';
import { AiCostBasis, AiDeploymentKind, AiUsageUnit } from '@arcaai/domains';

import {
  buildGuardrailUsageBatches,
  buildLlmUsageBatches,
  buildLlmUsageInput,
  buildLlmUsageInputFromTokenCounts,
  parseTextUsageDetail,
  type TextUsageDetail,
} from '../text-usage';

const TENANT = '50000000-0000-0000-0000-000000000000';

function detail(overrides: Partial<TextUsageDetail> = {}): TextUsageDetail {
  return {
    taskId: 'task-1',
    requestId: 'req-1',
    textProvider: 'lm-studio',
    model: 'qwen3-32b',
    endpointKind: 'openai.chat',
    interrupted: false,
    byok: false,
    connectionId: null,
    serviceTier: null,
    occurredAt: new Date('2026-09-12T10:00:00.000Z'),
    promptTokens: 100,
    completionTokens: 20,
    totalMs: 2500,
    engineMs: null,
    requestBytes: null,
    responseBytes: null,
    raw: null,
    ...overrides,
  };
}

type UnitLine = { unit: AiUsageUnit; quantity: number | string; attributesJson?: Record<string, unknown> | null };

const unitOf = (batch: { units: UnitLine[] } | null | undefined, unit: AiUsageUnit) => batch?.units.find((line) => line.unit === unit);

const quantityOf = (batch: { units: UnitLine[] } | null | undefined, unit: AiUsageUnit) => unitOf(batch, unit)?.quantity;

describe('parseTextUsageDetail — the four TASK-959 fields', () => {
  it('reads total_ms, engine_ms and both byte counts off the wire block', () => {
    const parsed = parseTextUsageDetail({
      endpoint_kind: 'openai.chat',
      task_id: 'task-1',
      provider: 'llama-cpp',
      model: 'qwen3-4b',
      prompt_tokens: 10,
      completion_tokens: 5,
      total_ms: 3210,
      engine_ms: 2980,
      request_bytes: 4096,
      response_bytes: 8192,
    });

    expect(parsed).toMatchObject({ totalMs: 3210, engineMs: 2980, requestBytes: 4096, responseBytes: 8192 });
  });

  it('reads them as null when omitted — an older TEXT measured nothing, it did not measure zero', () => {
    const parsed = parseTextUsageDetail({ endpoint_kind: 'openai.chat', task_id: 'task-1', provider: 'openai', prompt_tokens: 1 });
    expect(parsed).toMatchObject({ totalMs: null, engineMs: null, requestBytes: null, responseBytes: null });
  });

  it('refuses a non-numeric or negative reading rather than metering it', () => {
    const parsed = parseTextUsageDetail({
      endpoint_kind: 'openai.chat',
      task_id: 'task-1',
      provider: 'openai',
      prompt_tokens: 1,
      total_ms: 'fast',
      engine_ms: -5,
      request_bytes: null,
    });
    expect(parsed).toMatchObject({ totalMs: null, engineMs: null, requestBytes: null });
  });
});

describe('buildLlmUsageInput — a self-hosted call occupies a device', () => {
  it('records GPU_SECOND when the resolver said cuda, with the device on the compute row itself', () => {
    const batch = buildLlmUsageInput({ usage: detail(), tenantId: TENANT, operation: 'generate', device: 'cuda' });

    expect(quantityOf(batch, AiUsageUnit.GPU_SECOND)).toBe('2.500');
    expect(unitOf(batch, AiUsageUnit.GPU_SECOND)?.attributesJson).toEqual({ device: 'cuda' });
    // The dimension belongs to the row it describes: the token rows beside it are untouched, and
    // so is the batch's own bag.
    expect(batch?.common.attributesJson?.device).toBeUndefined();
    expect(unitOf(batch, AiUsageUnit.INPUT_TOKEN)?.attributesJson).toBeUndefined();
  });

  it('records CPU_SECOND when the device is cpu', () => {
    expect(quantityOf(buildLlmUsageInput({ usage: detail(), tenantId: TENANT, operation: 'generate', device: 'cpu' }), AiUsageUnit.CPU_SECOND)).toBe(
      '2.500',
    );
  });

  it('records NO compute row for a self-hosted call when nobody resolved a device', () => {
    // `cuda` and `cpu` are priced an order of magnitude apart, so the fallback for "unresolved"
    // is no row, not the cheaper one. The caller's `IComputeDeviceResolver` is what answers `cpu`
    // for a provider the map does not name; a caller that passed nothing asked no one, and its
    // tokens and bytes are still billed.
    const batch = buildLlmUsageInput({ usage: detail(), tenantId: TENANT, operation: 'generate' });

    expect(quantityOf(batch, AiUsageUnit.CPU_SECOND)).toBeUndefined();
    expect(quantityOf(batch, AiUsageUnit.GPU_SECOND)).toBeUndefined();
    expect(quantityOf(batch, AiUsageUnit.INPUT_TOKEN)).toBe(100);
  });

  it('prefers the engine clock over the client wall clock', () => {
    const batch = buildLlmUsageInput({ usage: detail({ engineMs: 1800 }), tenantId: TENANT, operation: 'generate', device: 'cuda' });
    expect(quantityOf(batch, AiUsageUnit.GPU_SECOND)).toBe('1.800');
  });

  it('emits no compute row for an older TEXT that reported no timing at all', () => {
    const batch = buildLlmUsageInput({ usage: detail({ totalMs: null }), tenantId: TENANT, operation: 'generate', device: 'cuda' });
    expect(quantityOf(batch, AiUsageUnit.GPU_SECOND)).toBeUndefined();
    expect(quantityOf(batch, AiUsageUnit.CPU_SECOND)).toBeUndefined();
    expect(quantityOf(batch, AiUsageUnit.INPUT_TOKEN)).toBe(100);
  });

  it('stamps byteSource: wire — TEXT counts at its httpx transport, not at an app-level proxy', () => {
    const batch = buildLlmUsageInput({
      usage: detail({ textProvider: 'openai', requestBytes: 4096, responseBytes: 8192 }),
      tenantId: TENANT,
      operation: 'generate',
    });

    expect(quantityOf(batch, AiUsageUnit.EGRESS_BYTE)).toBe('4096');
    expect(quantityOf(batch, AiUsageUnit.INGRESS_BYTE)).toBe('8192');
    // Per byte row, not on `common`: the token rows this batch already carried say nothing about
    // how a byte count was taken.
    expect(unitOf(batch, AiUsageUnit.EGRESS_BYTE)?.attributesJson).toEqual({ byteSource: 'wire' });
    expect(batch?.common.attributesJson?.byteSource).toBeUndefined();
  });
});

describe('buildLlmUsageBatches — the platform CPU leg of a third-party call', () => {
  it('meters a CLOUD call on CPU_SECOND, on the same INTERNAL batch', () => {
    const result = buildLlmUsageBatches({
      usage: detail({ textProvider: 'openai', model: 'gpt-5' }),
      tenantId: TENANT,
      operation: 'generate',
      // Even a wrongly-resolved cuda must not bill a GPU second to a vendor call.
      device: 'cuda',
    });

    expect(result?.batch.common.deployment).toBe(AiDeploymentKind.CLOUD);
    expect(quantityOf(result?.batch, AiUsageUnit.CPU_SECOND)).toBe('2.500');
    expect(quantityOf(result?.batch, AiUsageUnit.GPU_SECOND)).toBeUndefined();
    expect(result?.platformBatch).toBeUndefined();
  });

  it('splits a BYOK call: notional tokens on one batch, the platform second on the other', () => {
    const result = buildLlmUsageBatches({
      usage: detail({ textProvider: 'anthropic', model: 'claude-sonnet-5', byok: true, connectionId: 'conn-7' }),
      tenantId: TENANT,
      operation: 'generate',
    });

    expect(result?.batch.common.costBasis).toBe(AiCostBasis.BYOK_NOTIONAL);
    expect(quantityOf(result?.batch, AiUsageUnit.CPU_SECOND)).toBeUndefined();

    expect(result?.platformBatch?.common.costBasis).toBe(AiCostBasis.INTERNAL);
    expect(result?.platformBatch?.common.deployment).toBe(AiDeploymentKind.BYOK);
    expect(quantityOf(result?.platformBatch, AiUsageUnit.CPU_SECOND)).toBe('2.500');
    // The account that was spent rides both halves — one call, one connection.
    expect(result?.platformBatch?.common.connectionId).toBe('conn-7');
  });

  it('returns the same main batch the long-standing builder returns', () => {
    const params = { usage: detail(), tenantId: TENANT, operation: 'generate' as const, device: 'cuda' as const };
    expect(buildLlmUsageBatches(params)?.batch).toEqual(buildLlmUsageInput(params));
  });
});

describe('buildGuardrailUsageBatches — the guard call is timed too', () => {
  it('records the platform CPU of a guardrail call beside its tokens', () => {
    const result = buildGuardrailUsageBatches({
      usage: detail({ textProvider: 'openai', totalMs: 400 }),
      tenantId: TENANT,
    });

    expect(result?.batch.common.operation).toBe('guardrail.validate');
    expect(quantityOf(result?.batch, AiUsageUnit.CPU_SECOND)).toBe('0.400');
  });
});

describe('buildLlmUsageInputFromTokenCounts — the builder with no usage block', () => {
  it('accepts a device and a timing from its caller', () => {
    const batch = buildLlmUsageInputFromTokenCounts({
      tenantId: TENANT,
      operation: 'generate',
      requestId: 'req-9',
      provider: 'lm-studio',
      deployment: AiDeploymentKind.SELF_HOSTED,
      occurredAt: new Date('2026-09-12T10:00:00.000Z'),
      inputTokens: 50,
      outputTokens: 10,
      device: 'cuda',
      totalMs: 1500,
    });

    expect(quantityOf(batch, AiUsageUnit.GPU_SECOND)).toBe('1.500');
  });

  it('is byte-identical to before when the caller measured nothing', () => {
    const params = {
      tenantId: TENANT,
      operation: 'generate' as const,
      requestId: 'req-9',
      provider: 'lm-studio',
      deployment: AiDeploymentKind.SELF_HOSTED,
      occurredAt: new Date('2026-09-12T10:00:00.000Z'),
      inputTokens: 50,
      outputTokens: 10,
    };
    const batch = buildLlmUsageInputFromTokenCounts(params);

    expect(batch?.units.map((line) => line.unit)).toEqual([AiUsageUnit.INPUT_TOKEN, AiUsageUnit.OUTPUT_TOKEN]);
    expect(batch?.common.attributesJson).toEqual({ interrupted: false });
  });
});
