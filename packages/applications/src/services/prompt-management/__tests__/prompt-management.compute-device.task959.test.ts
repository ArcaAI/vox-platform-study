/**
 * TASK-959 T6 — the prompt-template bench passes the RESOLVED device.
 *
 * The bench bills `generate.stream` from a SERVER-SIDE `GET /tasks/{id}` read-back, and
 * `apps/text` persists its full usage block with the task — so a bench run on the platform's own
 * LM Studio has a real occupancy reading and, after lane SWAP, recorded no compute row for it
 * because nothing resolved a device.
 *
 * The BARE-COUNTS fallback branch deliberately gets none: `TaskResponse` in that shape carries
 * no timing at all, so there is no compute row for a device to ride on.
 */
import { AiCostBasis, AiUsageUnit } from '@arcaai/domains';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { PromptManagementService } from '../prompt-management.service';

const TENANT = 'tenant-1';

function usageDetail(overrides: Record<string, unknown> = {}) {
  return {
    task_id: 'task-1',
    provider: 'lm-studio',
    model: 'medgemma',
    endpoint_kind: 'openai.chat',
    interrupted: false,
    byok: false,
    occurred_at: '2026-09-12T10:00:00.000Z',
    prompt_tokens: 200,
    completion_tokens: 60,
    total_ms: 5400,
    raw: { prompt_tokens: 200, completion_tokens: 60 },
    ...overrides,
  };
}

const template = () => ({
  id: 'tpl-1',
  tenantId: TENANT,
  scope: 'TENANT_DEFAULT',
  category: 'GENERAL',
  content: 'Summarize the case.',
  variables: null,
  version: 1,
  lastTestScore: null as number | null,
  lastTestOutput: null as string | null,
  lastTestAt: null as Date | null,
});

const usageLedgerService = { recordUsage: vi.fn().mockResolvedValue(undefined) };

function makeService(opts: { computeDevice?: unknown; task?: Record<string, unknown> } = {}) {
  const get = vi.fn().mockResolvedValue({
    data: { status: 'completed', content: 'a reasonably long generated answer for the scorer to chew on', ...(opts.task ?? { usage_detail: usageDetail() }) },
  });
  const computeDevice = opts.computeDevice === undefined ? { resolve: vi.fn().mockResolvedValue('cuda') } : opts.computeDevice;
  const service = new PromptManagementService(
    {
      findById: vi.fn().mockResolvedValue(template()),
      encryptFieldsIntoEntity: vi.fn().mockResolvedValue(undefined),
      updateWithVersion: vi.fn().mockResolvedValue({ id: 'tpl-1', version: 2 }),
    } as never,
    { findByVersionNumber: vi.fn() } as never,
    {} as never, // promptUsageRecordRepository
    {} as never, // departmentService
    { emit: vi.fn() } as never,
    {
      get: vi.fn((key: string) =>
        key === 'tenantId'
          ? TENANT
          : key === 'userAbility'
            ? { can: () => true }
            : key === 'user'
              ? { id: 'user-1' }
              : key === 'userId'
                ? 'user-1'
                : undefined,
      ),
      set: vi.fn(),
    } as never,
    {} as never, // databaseService
    { axiosRef: { get, post: vi.fn() } } as never,
    { get: vi.fn(() => 'http://text.test') } as never,
    { getSecretOptional: vi.fn().mockResolvedValue('') } as never, // secretsService
    undefined, // userProfileService
    undefined, // entitlements
    undefined, // promotionGate
    undefined, // aiModelRepository
    undefined, // goldenCaseRepository
    undefined, // textRequestEnrichment
    undefined, // textAgents
    usageLedgerService as never,
    computeDevice as never,
  );
  return { service, computeDevice: computeDevice as { resolve: ReturnType<typeof vi.fn> } };
}

type Recorded = { common: { costBasis?: string }; units: { unit: AiUsageUnit; quantity: unknown; attributesJson?: Record<string, unknown> | null }[] };

const recorded = (costBasis?: string): Recorded[] =>
  usageLedgerService.recordUsage.mock.calls.map((call) => call[0] as Recorded).filter((batch) => costBasis === undefined || batch.common.costBasis === costBasis);

const finalize = (service: PromptManagementService) => service.finalizePromptTemplateTest('tpl-1', { taskId: 'task-1', expectedVersion: 1 } as never);

beforeEach(() => vi.clearAllMocks());

describe('PromptManagementService — the resolved compute device reaches the ledger (TASK-959 T6)', () => {
  it('records a GPU_SECOND row carrying the device resolved for the serving provider', async () => {
    const harness = makeService();

    await finalize(harness.service);

    expect(harness.computeDevice.resolve).toHaveBeenCalledWith(TENANT, 'lm-studio');
    const [batch] = recorded();
    expect(batch.units.find((unit) => unit.unit === AiUsageUnit.GPU_SECOND)).toEqual({
      unit: AiUsageUnit.GPU_SECOND,
      quantity: '5.400',
      attributesJson: { device: 'cuda' },
    });
  });

  it('keeps the token rows and drops only the compute row when the resolver throws', async () => {
    const harness = makeService({ computeDevice: { resolve: vi.fn().mockRejectedValue(new Error('settings backend down')) } });

    await expect(finalize(harness.service)).resolves.toBeDefined();

    expect(recorded()[0].units.map((unit) => unit.unit)).toEqual([AiUsageUnit.INPUT_TOKEN, AiUsageUnit.OUTPUT_TOKEN]);
  });

  it('records the platform CPU leg of a BYOK bench run as its own INTERNAL batch', async () => {
    const harness = makeService({ task: { usage_detail: usageDetail({ provider: 'openai', byok: true }) } });

    await finalize(harness.service);

    expect(recorded(AiCostBasis.BYOK_NOTIONAL)[0].units.map((unit) => unit.unit)).toEqual([AiUsageUnit.INPUT_TOKEN, AiUsageUnit.OUTPUT_TOKEN]);
    expect(recorded(AiCostBasis.INTERNAL)[0].units).toEqual([{ unit: AiUsageUnit.CPU_SECOND, quantity: '5.400', attributesJson: { device: 'cpu' } }]);
  });

  it('does not read the cascade at all for the bare-counts fallback — it has no occupancy to price', async () => {
    const harness = makeService({ task: { provider: 'lm-studio', model: 'medgemma', usage: { prompt_tokens: 10, completion_tokens: 5 } } });

    await finalize(harness.service);

    expect(harness.computeDevice.resolve).not.toHaveBeenCalled();
    expect(recorded()[0].units.map((unit) => unit.unit)).toEqual([AiUsageUnit.INPUT_TOKEN, AiUsageUnit.OUTPUT_TOKEN]);
  });
});
