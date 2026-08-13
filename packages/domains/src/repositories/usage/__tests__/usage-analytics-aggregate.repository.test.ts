import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { AiCapability } from '../../../enums';
import { UsageAnalyticsAggregateRepository } from '../UsageAnalyticsAggregateRepository';

/**
 * Hand-written usage-analytics repository extensions.
 *
 * Mirrors the `BillingUsageAggregateRepository` test style: mock
 * `$queryRaw`, assert the bound parameters, and assert bigint/decimal parsing.
 */

const TENANT = '11111111-1111-1111-1111-111111111111';
const FROM = new Date('2026-08-01T00:00:00.000Z');
const TO = new Date('2026-09-01T00:00:00.000Z');

function fakeUow(client: unknown): CoreUnitOfWorkService {
  return { getDatabaseService: () => client } as unknown as CoreUnitOfWorkService;
}

describe('UsageAnalyticsAggregateRepository.sumCostPerConsultation', () => {
  it('maps consultationId/costMicros rows to bigint', async () => {
    const queryRaw = vi.fn().mockResolvedValue([
      { consultationId: 'c-1', costMicros: 100000n },
      { consultationId: 'c-2', costMicros: '250000' },
    ]);
    const repo = new UsageAnalyticsAggregateRepository(fakeUow({ $queryRaw: queryRaw }));

    const rows = await repo.sumCostPerConsultation(TENANT, FROM, TO);

    expect(rows).toEqual([
      { consultationId: 'c-1', costMicros: 100000n },
      { consultationId: 'c-2', costMicros: 250000n },
    ]);
    const sqlArg = queryRaw.mock.calls[0][0];
    expect(sqlArg.values).toEqual(expect.arrayContaining([TENANT, FROM, TO]));
  });

  it('degrades a null sum to 0n', async () => {
    const queryRaw = vi.fn().mockResolvedValue([{ consultationId: 'c-1', costMicros: null }]);
    const repo = new UsageAnalyticsAggregateRepository(fakeUow({ $queryRaw: queryRaw }));
    const rows = await repo.sumCostPerConsultation(TENANT, FROM, TO);
    expect(rows[0].costMicros).toBe(0n);
  });
});

describe('UsageAnalyticsAggregateRepository.topTenantsByCost', () => {
  let queryRaw: ReturnType<typeof vi.fn>;
  let repo: UsageAnalyticsAggregateRepository;

  beforeEach(() => {
    queryRaw = vi.fn().mockResolvedValue([
      { tenantId: 't-1', costMicros: 900000n },
      { tenantId: 't-2', costMicros: 500000n },
    ]);
    repo = new UsageAnalyticsAggregateRepository(fakeUow({ $queryRaw: queryRaw }));
  });

  it('runs WITHOUT a tenantId filter (deliberate cross-tenant bypass)', async () => {
    const rows = await repo.topTenantsByCost(FROM, TO, 10);
    expect(rows).toEqual([
      { tenantId: 't-1', costMicros: 900000n },
      { tenantId: 't-2', costMicros: 500000n },
    ]);
    const sqlArg = queryRaw.mock.calls[0][0];
    expect(sqlArg.values).not.toContain(TENANT);
    expect(sqlArg.values).toEqual(expect.arrayContaining([FROM, TO, 10]));
  });

  it('narrows by capability when supplied', async () => {
    await repo.topTenantsByCost(FROM, TO, 5, AiCapability.LLM);
    const sqlArg = queryRaw.mock.calls[0][0];
    expect(sqlArg.values).toEqual(expect.arrayContaining([FROM, TO, 5, 'LLM']));
  });
});

describe('UsageAnalyticsAggregateRepository.sumByokNotionalByCapability', () => {
  it('maps capability/costMicros rows', async () => {
    const queryRaw = vi.fn().mockResolvedValue([{ capability: 'LLM', costMicros: 42000n }]);
    const repo = new UsageAnalyticsAggregateRepository(fakeUow({ $queryRaw: queryRaw }));
    const rows = await repo.sumByokNotionalByCapability(TENANT, FROM, TO);
    expect(rows).toEqual([{ capability: AiCapability.LLM, costMicros: 42000n }]);
  });
});
