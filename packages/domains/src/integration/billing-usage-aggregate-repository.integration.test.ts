/**
 * BillingUsageAggregateRepository — live SQL integration test.
 *
 * Scope note: "Integration round-trip for the raw-SQL
 * aggregates flagged (BillingUsageAggregateRepository) … the unit
 * suites mock $queryRaw; the SQL itself needs one live execution each."
 * `sell-rate-card`/`billing` unit tests mock `$queryRaw` entirely (they
 * assert the QUERY SHAPE, never that the SQL is syntactically valid
 * Postgres) — this file is the one place both queries actually execute
 * against a real database: `date_trunc`, the `CAST(... AS "core"."AiCapability")`
 * / `"core"."AiCostBasis"` enum casts, and the `Prisma.join` IN-list.
 *
 * Prerequisites: `pnpm infra:test:up` + `pnpm test:db:push` (isolated test
 * Postgres, port 5433 — see `tests/README.md`). Run with `pnpm test:integration`.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach } from 'vitest';
// eslint-disable-next-line no-restricted-imports -- allow-list: integration test fixture, tenant context not yet established
import { getPlatformAdminPrismaClient_Unscoped, CorePrismaClient } from '@arcaai/database';
import { BillingUsageAggregateRepository } from '../repositories/billing/BillingUsageAggregateRepository';
import { AiCapability, AiCostBasis, AiDeploymentKind, AiUsageUnit } from '../enums';

const TEST_TENANT_ID = '50000000-0000-0000-0000-000000000099';
const OTHER_TENANT_ID = '50000000-0000-0000-0000-000000000098';

/** Minimal UnitOfWork stub — mirrors `repository-soft-delete.integration.test.ts`'s pattern; `BillingUsageAggregateRepository.client` only calls `getDatabaseService()`. */
function createUnitOfWorkStub(extendedClient: CorePrismaClient) {
  return { getDatabaseService: () => extendedClient };
}

function eventRow(overrides: Partial<Record<string, unknown>> = {}) {
  return {
    tenantId: TEST_TENANT_ID,
    idempotencyKey: `task615-integration-${Math.random().toString(36).slice(2)}`,
    occurredAt: new Date('2026-08-10T12:00:00.000Z'),
    capability: AiCapability.LLM,
    operation: 'generate',
    provider: 'lm-studio',
    model: 'llama-3.1-8b',
    deployment: AiDeploymentKind.SELF_HOSTED,
    unit: AiUsageUnit.INPUT_TOKEN,
    quantity: '100',
    costBasis: AiCostBasis.INTERNAL,
    costMicros: 500n,
    unitPriceMicros: 5n,
    priceBookVersion: 'test-v1',
    ...overrides,
  };
}

describe('BillingUsageAggregateRepository (live SQL)', () => {
  let repository: BillingUsageAggregateRepository;
  let basePrisma: CorePrismaClient;

  beforeAll(async () => {
    basePrisma = getPlatformAdminPrismaClient_Unscoped();
    await basePrisma.$connect();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the stub UOW only needs to satisfy `getDatabaseService()`, not the full CoreUnitOfWorkService surface
    repository = new BillingUsageAggregateRepository(createUnitOfWorkStub(basePrisma) as any);
  });

  afterAll(async () => {
    await basePrisma.$disconnect();
  });

  beforeEach(async () => {
    await basePrisma.$executeRaw`DELETE FROM core."AiUsageEvent" WHERE "tenantId" IN (${TEST_TENANT_ID}, ${OTHER_TENANT_ID})`;
  });

  describe('sumDailyQuantitiesByOperation', () => {
    it('sums quantities per (day, unit, operation), scoped to the requested tenant', async () => {
      await basePrisma.aiUsageEvent.createMany({
        data: [
          eventRow({ operation: 'generate', unit: AiUsageUnit.INPUT_TOKEN, quantity: '100' }),
          eventRow({ operation: 'generate', unit: AiUsageUnit.INPUT_TOKEN, quantity: '50' }),
          eventRow({ operation: 'guardrail.validate', unit: AiUsageUnit.INPUT_TOKEN, quantity: '30' }),
          // Different tenant — must NOT be summed into the target tenant's result.
          eventRow({ tenantId: OTHER_TENANT_ID, operation: 'generate', unit: AiUsageUnit.INPUT_TOKEN, quantity: '9999' }),
        ],
      });

      const rows = await repository.sumDailyQuantitiesByOperation({
        tenantId: TEST_TENANT_ID,
        capability: AiCapability.LLM,
        operations: ['generate', 'guardrail.validate'],
        from: new Date('2026-08-01T00:00:00.000Z'),
        to: new Date('2026-09-01T00:00:00.000Z'),
      });

      const generateRow = rows.find((r) => r.operation === 'generate');
      const guardrailRow = rows.find((r) => r.operation === 'guardrail.validate');

      expect(generateRow?.quantity.toString()).toBe('150');
      expect(guardrailRow?.quantity.toString()).toBe('30');
      expect(rows.every((r) => r.unit === AiUsageUnit.INPUT_TOKEN)).toBe(true);
    });

    it('excludes events outside the [from, to) window and events for an unrequested operation', async () => {
      await basePrisma.aiUsageEvent.createMany({
        data: [
          eventRow({ occurredAt: new Date('2026-08-15T00:00:00.000Z'), operation: 'generate', quantity: '10' }),
          eventRow({ occurredAt: new Date('2026-07-31T23:59:59.000Z'), operation: 'generate', quantity: '999' }), // before window
          eventRow({ occurredAt: new Date('2026-09-01T00:00:00.000Z'), operation: 'generate', quantity: '999' }), // at the exclusive upper bound
          eventRow({ occurredAt: new Date('2026-08-15T00:00:00.000Z'), operation: 'harness.step', quantity: '999' }), // not in `operations`
        ],
      });

      const rows = await repository.sumDailyQuantitiesByOperation({
        tenantId: TEST_TENANT_ID,
        capability: AiCapability.LLM,
        operations: ['generate'],
        from: new Date('2026-08-01T00:00:00.000Z'),
        to: new Date('2026-09-01T00:00:00.000Z'),
      });

      expect(rows).toHaveLength(1);
      expect(rows[0].quantity.toString()).toBe('10');
    });

    it('returns an empty array without querying when `operations` is empty', async () => {
      const rows = await repository.sumDailyQuantitiesByOperation({
        tenantId: TEST_TENANT_ID,
        capability: AiCapability.LLM,
        operations: [],
        from: new Date('2026-08-01T00:00:00.000Z'),
        to: new Date('2026-09-01T00:00:00.000Z'),
      });
      expect(rows).toEqual([]);
    });
  });

  describe('sumByokNotionalCostMicros', () => {
    it('sums costMicros for BYOK_NOTIONAL events only, in-window, for the requested tenant', async () => {
      await basePrisma.aiUsageEvent.createMany({
        data: [
          eventRow({ costBasis: AiCostBasis.BYOK_NOTIONAL, costMicros: 1_000_000n }),
          eventRow({ costBasis: AiCostBasis.BYOK_NOTIONAL, costMicros: 500_000n }),
          eventRow({ costBasis: AiCostBasis.INTERNAL, costMicros: 9_999_999n }), // INTERNAL — must not be summed
          eventRow({ tenantId: OTHER_TENANT_ID, costBasis: AiCostBasis.BYOK_NOTIONAL, costMicros: 8_888_888n }), // other tenant — must not be summed
        ],
      });

      const sum = await repository.sumByokNotionalCostMicros(
        TEST_TENANT_ID,
        new Date('2026-08-01T00:00:00.000Z'),
        new Date('2026-09-01T00:00:00.000Z'),
      );

      expect(sum).toBe(1_500_000n);
    });

    it('degrades to 0n when there are no matching rows', async () => {
      const sum = await repository.sumByokNotionalCostMicros(
        TEST_TENANT_ID,
        new Date('2026-08-01T00:00:00.000Z'),
        new Date('2026-09-01T00:00:00.000Z'),
      );
      expect(sum).toBe(0n);
    });
  });
});
