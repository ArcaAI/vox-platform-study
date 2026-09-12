/**
 * TASK-959 T6 — the playground SSE proxy passes the RESOLVED device, and records the whole
 * stream rather than only its generation half.
 *
 * PEEK, RESOLVE, THEN TAKE. The device decides the compute UNIT, it is resolved from
 * configuration keyed by the provider that ACTUALLY served — known only once the terminal frame
 * is parsed — and that resolution is asynchronous, while the batch is built synchronously inside
 * `takeAll`. So the attribution is read first, without consuming anything.
 *
 * `takeAll` also hands back what `take` dropped: the `guardrail.validate` COGS row for the guard
 * call TEXT made on this stream's behalf, and the platform CPU leg of a BYOK stream.
 */
import { AiCostBasis, AiUsageUnit } from '@arcaai/domains';
import { EventEmitter } from 'node:events';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TextProxyController } from '../text-proxy.controller';

const USAGE = {
  task_id: 'text-task-9',
  request_id: 'corr-9',
  provider: 'lm-studio',
  model: 'qwen3-32b',
  endpoint_kind: 'openai.chat',
  interrupted: false,
  byok: false,
  occurred_at: '2026-09-12T10:00:00.000Z',
  prompt_tokens: 200,
  completion_tokens: 90,
  total_ms: 7200,
  raw: { prompt_tokens: 200, completion_tokens: 90 },
};

const GUARDRAIL_USAGE = {
  task_id: 'guard-9',
  provider: 'ollama',
  model: 'granite-guardian',
  endpoint_kind: 'openai.chat',
  interrupted: false,
  byok: false,
  occurred_at: '2026-09-12T09:59:59.000Z',
  prompt_tokens: 300,
  completion_tokens: 4,
  total_ms: 500,
  raw: { prompt_tokens: 300, completion_tokens: 4 },
};

function sseFrame(event: string, data: unknown, id = '1-0'): string {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\nid: ${id}\n\n`;
}

function makeResponse() {
  const res = new EventEmitter() as unknown as Record<string, unknown> & EventEmitter;
  res.setHeader = vi.fn();
  res.flushHeaders = vi.fn();
  res.write = vi.fn();
  res.end = vi.fn();
  res.status = vi.fn(() => res);
  res.json = vi.fn();
  res.writableEnded = false;
  res.headersSent = true;
  return res;
}

function build(opts: { computeDevice?: unknown } = {}) {
  const upstream = new EventEmitter() as EventEmitter & { destroy: ReturnType<typeof vi.fn> };
  upstream.destroy = vi.fn();

  const ledger = { recordUsage: vi.fn().mockResolvedValue({ outboxIds: ['o-1'], events: 2 }) };
  const computeDevice =
    opts.computeDevice === undefined
      ? { resolve: vi.fn(async (_tenantId: string, provider: string) => (provider === 'lm-studio' ? 'cuda' : 'cpu')) }
      : opts.computeDevice;

  const ctrl = new TextProxyController(
    { axiosRef: { get: vi.fn(async () => ({ data: upstream })), post: vi.fn() } } as never,
    { fetchByCodeName: vi.fn() } as never,
    { get: vi.fn((key: string) => (key === 'tenantId' ? 'tenant-1' : null)), getId: vi.fn(() => 'corr') } as never,
    { findById: vi.fn() } as never,
    { findById: vi.fn() } as never,
    { findById: vi.fn() } as never,
    { findById: vi.fn() } as never,
    { findById: vi.fn() } as never,
    { getObject: vi.fn() } as never,
    { getConfigValue: vi.fn(() => 'http://text') } as never,
    undefined, // secretsService
    undefined, // harnessPolicyService
    undefined, // aiModelService
    undefined, // routingPolicies
    undefined, // aiProviderConnectionService
    ledger as never,
    undefined, // dnaWritingStyleService
    undefined, // effectiveSettingsService
    undefined, // visitTypes
    undefined, // entitlements
    computeDevice as never,
  );

  return { ctrl, upstream, ledger, computeDevice: computeDevice as { resolve: ReturnType<typeof vi.fn> } };
}

type Recorded = { common: { operation: string; costBasis?: string }; units: { unit: AiUsageUnit; quantity: unknown; attributesJson?: Record<string, unknown> | null }[] };

const recorded = (ledger: { recordUsage: ReturnType<typeof vi.fn> }, operation: string, costBasis?: string): Recorded[] =>
  ledger.recordUsage.mock.calls
    .map((call) => call[0] as Recorded)
    .filter((input) => input.common.operation === operation && (costBasis === undefined || input.common.costBasis === costBasis));

/** Drive one complete stream and wait for the fire-and-forget emission to land. */
async function runStream(harness: ReturnType<typeof build>, usage: unknown = USAGE, guardrailUsage: unknown = GUARDRAIL_USAGE): Promise<void> {
  const res = makeResponse();
  await harness.ctrl.streamTaskEvents('text-task-9', undefined, res as never);
  harness.upstream.emit(
    'data',
    Buffer.from(sseFrame('done', { type: 'done', data: { finish_reason: 'stop', usage, ...(guardrailUsage ? { guardrail_usage: guardrailUsage } : {}) } })),
  );
  harness.upstream.emit('end');
  await vi.waitFor(() => expect(harness.ledger.recordUsage).toHaveBeenCalled());
}

beforeEach(() => vi.clearAllMocks());

describe('TEXT proxy — the resolved compute device reaches the ledger (TASK-959 T6)', () => {
  it('records a GPU_SECOND row carrying the device resolved for the provider on the TERMINAL FRAME', async () => {
    const harness = build();

    await runStream(harness);

    expect(harness.computeDevice.resolve).toHaveBeenCalledWith('tenant-1', 'lm-studio');
    const [generation] = recorded(harness.ledger, 'generate.stream');
    expect(generation.units.find((unit) => unit.unit === AiUsageUnit.GPU_SECOND)).toEqual({
      unit: AiUsageUnit.GPU_SECOND,
      quantity: '7.200',
      attributesJson: { device: 'cuda' },
    });
  });

  it('records the guardrail.validate COGS row the single-batch `take` used to drop', async () => {
    const harness = build();

    await vi.waitFor(async () => {
      await runStream(harness);
      expect(recorded(harness.ledger, 'guardrail.validate')).toHaveLength(1);
    });

    const [guardrail] = recorded(harness.ledger, 'guardrail.validate');
    expect(guardrail.common).toMatchObject({ operation: 'guardrail.validate' });
    expect(guardrail.units.map((unit) => unit.unit)).toContain(AiUsageUnit.INPUT_TOKEN);
  });

  it('keeps the token rows and drops only the compute row when the resolver throws', async () => {
    const harness = build({ computeDevice: { resolve: vi.fn().mockRejectedValue(new Error('settings backend down')) } });

    await runStream(harness, USAGE, null);

    const [generation] = recorded(harness.ledger, 'generate.stream');
    expect(generation.units.map((unit) => unit.unit)).toEqual([AiUsageUnit.INPUT_TOKEN, AiUsageUnit.OUTPUT_TOKEN]);
  });

  it('records the platform CPU leg of a BYOK stream as its own INTERNAL batch', async () => {
    const harness = build();

    await runStream(harness, { ...USAGE, provider: 'openai', byok: true }, null);

    expect(recorded(harness.ledger, 'generate.stream', AiCostBasis.BYOK_NOTIONAL)).toHaveLength(1);
    const [platform] = recorded(harness.ledger, 'generate.stream', AiCostBasis.INTERNAL);
    expect(platform.units).toEqual([{ unit: AiUsageUnit.CPU_SECOND, quantity: '7.200', attributesJson: { device: 'cpu' } }]);
  });
});
