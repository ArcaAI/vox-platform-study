/**
 * TASK-957 F-7a — the SYNC `POST /text-generations/generate` bills what it spends.
 *
 * The streaming twin of this route has metered since TASK-890 and bills the full
 * `usage_detail` (cache, reasoning, compute, bytes) plus the guardrail call TEXT made on its
 * behalf. The sync half of the SAME route emitted NOTHING — every non-streaming generation
 * through the playground proxy was inference nobody was charged for and no meter saw, on the
 * same platform credential.
 *
 * These tests pin the sync path to the stream path's shape: TEXT's own task id as the key, the
 * `usage_detail` breakdown, the guardrail COGS row beside it, the resolved compute device, and
 * the BYOK platform CPU leg as its own `INTERNAL` batch.
 */
import { AiCostBasis, AiDeploymentKind, AiUsageUnit } from '@arcaai/domains';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { TextProxyController } from '../text-proxy.controller';

const USAGE_DETAIL = {
  task_id: 'text-task-sync-1',
  request_id: 'corr-sync-1',
  provider: 'lm-studio',
  model: 'qwen3-32b',
  endpoint_kind: 'openai.chat',
  interrupted: false,
  byok: false,
  occurred_at: '2026-09-13T10:00:00.000Z',
  prompt_tokens: 120,
  completion_tokens: 45,
  total_ms: 4000,
  raw: { prompt_tokens: 120, completion_tokens: 45 },
};

const GUARDRAIL_USAGE = {
  task_id: 'guard-sync-1',
  provider: 'ollama',
  model: 'granite-guardian',
  endpoint_kind: 'openai.chat',
  interrupted: false,
  byok: false,
  occurred_at: '2026-09-13T09:59:59.000Z',
  prompt_tokens: 300,
  completion_tokens: 4,
  total_ms: 900,
  raw: { prompt_tokens: 300, completion_tokens: 4 },
};

type Recorded = {
  common: {
    operation: string;
    idempotencyKey: string;
    requestId?: string | null;
    provider: string;
    deployment: string;
    costBasis?: string;
    attributesJson?: Record<string, unknown> | null;
  };
  units: { unit: AiUsageUnit; quantity: unknown; attributesJson?: Record<string, unknown> | null }[];
};

function build(opts: { data?: unknown; computeDevice?: unknown } = {}) {
  const ledger = { recordUsage: vi.fn().mockResolvedValue({ outboxIds: ['o-1'], events: 2 }) };
  const post = vi.fn(async () => ({
    data: opts.data ?? { task_id: 'text-task-sync-1', content: 'hi', usage_detail: USAGE_DETAIL, guardrail_usage: GUARDRAIL_USAGE },
  }));
  const computeDevice =
    opts.computeDevice === undefined
      ? { resolve: vi.fn(async (_tenantId: string, provider: string) => (provider === 'lm-studio' ? 'cuda' : 'cpu')) }
      : opts.computeDevice;

  const ctrl = new TextProxyController(
    { axiosRef: { get: vi.fn(), post } } as never,
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

  return { ctrl, ledger, post, computeDevice: computeDevice as { resolve: ReturnType<typeof vi.fn> } };
}

const recorded = (ledger: { recordUsage: ReturnType<typeof vi.fn> }, operation: string, costBasis?: string): Recorded[] =>
  ledger.recordUsage.mock.calls
    .map((call) => call[0] as Recorded)
    .filter((input) => input.common.operation === operation && (costBasis === undefined || input.common.costBasis === costBasis));

const quantity = (row: Recorded | undefined, unit: AiUsageUnit): unknown => row?.units.find((u) => u.unit === unit)?.quantity;

/** Drive one sync generation and wait for the fire-and-forget emission to land. */
async function run(harness: ReturnType<typeof build>, body: Record<string, unknown> = { prompt: 'hello' }): Promise<unknown> {
  const result = await harness.ctrl.generate(body as never);
  await vi.waitFor(() => expect(harness.ledger.recordUsage).toHaveBeenCalled());
  return result;
}

describe('TASK-957 F-7a — sync /text-generations/generate usage', () => {
  beforeEach(() => vi.clearAllMocks());

  it('records a `generate` row keyed on TEXT’s OWN task id, not a fresh gateway id', async () => {
    const harness = build();
    await run(harness);

    const [generation] = recorded(harness.ledger, 'generate');
    expect(generation).toBeDefined();
    // The only join between a ledger row and TEXT's persisted task log — what a
    // disputed invoice is reconciled from.
    expect(generation.common.idempotencyKey).toBe('llm:text-task-sync-1');
    expect(generation.common.requestId).toBe('text-task-sync-1');
    expect(quantity(generation, AiUsageUnit.INPUT_TOKEN)).toBe(120);
    expect(quantity(generation, AiUsageUnit.OUTPUT_TOKEN)).toBe(45);
  });

  it('records the guardrail COGS row TEXT reported beside the generation', async () => {
    const harness = build();
    await run(harness);

    const [guardrail] = recorded(harness.ledger, 'guardrail.validate');
    expect(guardrail).toBeDefined();
    expect(guardrail.common.idempotencyKey).toBe('guardrail:guard-sync-1');
    expect(quantity(guardrail, AiUsageUnit.INPUT_TOKEN)).toBe(300);
    // The screening call is not itself screened — stamping a disposition on it
    // would be circular.
    expect(guardrail.common.attributesJson?.guardrail).toBeUndefined();
  });

  it('resolves the compute device from the provider that ACTUALLY served', async () => {
    const harness = build();
    await run(harness);

    expect(harness.computeDevice.resolve).toHaveBeenCalledWith('tenant-1', 'lm-studio');
    const [generation] = recorded(harness.ledger, 'generate');
    const compute = generation.units.find((u) => u.unit === AiUsageUnit.GPU_SECOND);
    expect(compute?.quantity).toBe('4.000');
    expect(compute?.attributesJson).toEqual({ device: 'cuda' });
  });

  it('splits the platform CPU leg of a BYOK generation onto its own INTERNAL batch', async () => {
    const harness = build({
      data: {
        usage_detail: { ...USAGE_DETAIL, provider: 'openai', byok: true, total_ms: 2500 },
      },
    });
    await run(harness);

    const [tokens] = recorded(harness.ledger, 'generate', AiCostBasis.BYOK_NOTIONAL);
    expect(tokens.common.deployment).toBe(AiDeploymentKind.BYOK);
    const [platform] = recorded(harness.ledger, 'generate', AiCostBasis.INTERNAL);
    // A vendor ran the model; what HOPE spent is the CPU of the call it made.
    expect(quantity(platform, AiUsageUnit.CPU_SECOND)).toBe('2.500');
  });

  it('records NOTHING for a STREAMING request — that half is metered on teardown of the SSE relay', async () => {
    const harness = build({ data: 'event: start\ndata: {"task_id":"t-9"}\n\n' });
    // A streaming `postTextGenerate` hands back a Readable; a double emission here
    // would bill the same generation twice, once per half of the two-call surface.
    await harness.ctrl.generate({ prompt: 'hello', stream: true } as never).catch(() => undefined);
    expect(harness.ledger.recordUsage).not.toHaveBeenCalled();
  });

  it('records nothing when TEXT sent no usage block at all', async () => {
    const harness = build({ data: { task_id: 't', content: 'hi' } });
    await harness.ctrl.generate({ prompt: 'hello' } as never);
    await new Promise((resolve) => setImmediate(resolve));
    expect(harness.ledger.recordUsage).not.toHaveBeenCalled();
  });
});
