/**
 * TASK-959 T6 — the draft-agent bench passes the RESOLVED device.
 *
 * The bench bills `generate.stream` from a SERVER-SIDE `GET /tasks/{id}` read-back, and
 * `apps/text` persists its full usage block with the task — so a bench run on the platform's own
 * LM Studio has a real occupancy reading and, after lane SWAP, recorded no compute row for it
 * because nothing resolved a device.
 *
 * The BARE-COUNTS fallback branch deliberately gets none: that shape (`{prompt_tokens,
 * completion_tokens}` and nothing else) carries no timing at all, so there is no compute row for
 * a device to ride on.
 */
import { AiCostBasis, AiUsageUnit } from '@arcaai/domains';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AgentDraftTestService } from '../agent-draft-test.service';

const TENANT = '50000000-0000-0000-0000-000000000000';

function usageDetail(overrides: Record<string, unknown> = {}) {
  return {
    task_id: 'task-1',
    provider: 'lm-studio',
    model: 'gemma',
    endpoint_kind: 'openai.chat',
    interrupted: false,
    byok: false,
    occurred_at: '2026-09-12T10:00:00.000Z',
    prompt_tokens: 120,
    completion_tokens: 40,
    total_ms: 4200,
    raw: { prompt_tokens: 120, completion_tokens: 40 },
    ...overrides,
  };
}

const get = vi.fn();
const httpService = { axiosRef: { post: vi.fn(), get } };
const usageLedger = { recordUsage: vi.fn() };

function makeTransport(computeDevice: unknown) {
  return new AgentDraftTestService(
    { get: vi.fn(() => TENANT) } as never,
    httpService as never,
    { get: vi.fn(() => 'http://text.test') } as never,
    undefined as never, // secretsService
    undefined as never, // textRequestEnrichment
    { assertMeterQuota: vi.fn() } as never,
    usageLedger as never,
    undefined as never, // credentials
    computeDevice as never,
  );
}

type Recorded = { common: { costBasis?: string }; units: { unit: AiUsageUnit; quantity: unknown; attributesJson?: Record<string, unknown> | null }[] };

const recorded = (costBasis?: string): Recorded[] =>
  usageLedger.recordUsage.mock.calls.map((call) => call[0] as Recorded).filter((batch) => costBasis === undefined || batch.common.costBasis === costBasis);

beforeEach(() => vi.clearAllMocks());

describe('AgentDraftTestService — the resolved compute device reaches the ledger (TASK-959 T6)', () => {
  it('records a GPU_SECOND row carrying the device resolved for the serving provider', async () => {
    const resolve = vi.fn().mockResolvedValue('cuda');
    get.mockResolvedValue({ data: { status: 'completed', content: 'draft', provider: 'lm-studio', model: 'gemma', usage_detail: usageDetail() } });

    await makeTransport({ resolve }).finalize(TENANT, 'task-1');

    expect(resolve).toHaveBeenCalledWith(TENANT, 'lm-studio');
    const [batch] = recorded();
    expect(batch.units.find((unit) => unit.unit === AiUsageUnit.GPU_SECOND)).toEqual({
      unit: AiUsageUnit.GPU_SECOND,
      quantity: '4.200',
      attributesJson: { device: 'cuda' },
    });
  });

  it('keeps the token rows and drops only the compute row when the resolver throws', async () => {
    get.mockResolvedValue({ data: { status: 'completed', content: 'draft', provider: 'lm-studio', model: 'gemma', usage_detail: usageDetail() } });

    await expect(makeTransport({ resolve: vi.fn().mockRejectedValue(new Error('settings backend down')) }).finalize(TENANT, 'task-1')).resolves.toBeDefined();

    const [batch] = recorded();
    expect(batch.units.map((unit) => unit.unit)).toEqual([AiUsageUnit.INPUT_TOKEN, AiUsageUnit.OUTPUT_TOKEN]);
  });

  it('records the platform CPU leg of a BYOK bench run as its own INTERNAL batch', async () => {
    get.mockResolvedValue({
      data: { status: 'completed', content: 'draft', provider: 'openai', model: 'gpt-5', usage_detail: usageDetail({ provider: 'openai', byok: true }) },
    });

    await makeTransport({ resolve: vi.fn().mockResolvedValue('cpu') }).finalize(TENANT, 'task-1');

    expect(recorded(AiCostBasis.BYOK_NOTIONAL)[0].units.map((unit) => unit.unit)).toEqual([AiUsageUnit.INPUT_TOKEN, AiUsageUnit.OUTPUT_TOKEN]);
    expect(recorded(AiCostBasis.INTERNAL)[0].units).toEqual([{ unit: AiUsageUnit.CPU_SECOND, quantity: '4.200', attributesJson: { device: 'cpu' } }]);
  });

  it('does not read the cascade at all for the bare-counts fallback — it has no occupancy to price', async () => {
    const resolve = vi.fn().mockResolvedValue('cuda');
    get.mockResolvedValue({
      data: { status: 'completed', content: 'draft', provider: 'lm-studio', model: 'gemma', usage: { prompt_tokens: 10, completion_tokens: 5 } },
    });

    await makeTransport({ resolve }).finalize(TENANT, 'task-1');

    expect(resolve).not.toHaveBeenCalled();
    expect(recorded()[0].units.map((unit) => unit.unit)).toEqual([AiUsageUnit.INPUT_TOKEN, AiUsageUnit.OUTPUT_TOKEN]);
  });
});
