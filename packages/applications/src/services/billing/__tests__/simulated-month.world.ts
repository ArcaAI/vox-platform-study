import Decimal from 'decimal.js';
import { vi } from 'vitest';
import { AiCapability, AiDeploymentKind, AiUsageUnit, BillingAdjustmentFactory, BillingInvoiceEntity, TenantEntity, TenantPlan } from '@arcaai/domains';

import { BillingService } from '../billing.service';

/**
 * The composite fixture behind `simulated-month.golden.test.ts` — one PRO
 * tenant's August 2026 with every billing mechanism active at once. Kept in a
 * sibling module so the golden test file reads as the evidence document.
 */
export function makeSimulatedWorld() {
  const TENANT = 'aaaaaaaa-0000-0000-0000-000000000001';
  const day = (d: number): Date => new Date(Date.UTC(2026, 7, d));

  interface InvoiceRow {
    props: Record<string, unknown>;
    version: number;
  }
  const invoices = new Map<string, InvoiceRow>();
  const materialize = (row: InvoiceRow): BillingInvoiceEntity => new BillingInvoiceEntity({ ...(row.props as never), version: row.version });

  const invoiceRepository = {
    findByPeriod: vi.fn(async () => null),
    findById: vi.fn(async (id: string) => materialize(invoices.get(id)!)),
    findByTenant: vi.fn(async () => [...invoices.values()].map(materialize)),
    create: vi.fn(async (entity: BillingInvoiceEntity) => {
      invoices.set(entity.id, {
        props: {
          id: entity.id,
          tenantId: entity.tenantId,
          periodStart: entity.periodStart,
          periodEnd: entity.periodEnd,
          status: entity.status,
          currency: entity.currency,
          subtotalMicros: entity.subtotalMicros,
          totalMicros: entity.totalMicros,
          finalizedAt: null,
          finalizedBy: null,
          createdAt: entity.createdAt,
          updatedAt: entity.updatedAt,
        },
        version: 1,
      });
      return entity;
    }),
    updateWithVersion: vi.fn(),
  };

  const lineRepository = {
    softDeleteByInvoice: vi.fn(async () => 0),
    createMany: vi.fn(async (entities: unknown[]) => ({ count: entities.length })),
    findByInvoice: vi.fn(async () => []),
  };

  // A credit memo issued 2026-08-15 against July's FINALIZED invoice — it must
  // carry forward onto the August draft.
  const julyMemo = BillingAdjustmentFactory.CreateBillingAdjustment({
    tenantId: TENANT,
    invoiceId: 'july-invoice',
    reason: 'sla_credit',
    amountMicros: -10_000_000n,
    createdAt: day(15),
  });
  const adjustmentRepository = {
    create: vi.fn(),
    findByInvoice: vi.fn(async () => []),
    findAll: vi.fn(async () => [julyMemo]),
  };

  const rollup = (
    d: number,
    capability: AiCapability,
    unit: AiUsageUnit,
    quantity: number,
    provider = 'test',
    deployment: AiDeploymentKind = AiDeploymentKind.SELF_HOSTED,
  ) => ({
    bucketStart: day(d),
    capability,
    unit,
    provider,
    deployment,
    model: '',
    quantitySum: new Decimal(quantity),
  });
  const rollupRepository = {
    findByPeriod: vi.fn(async () => [
      rollup(3, AiCapability.STT, AiUsageUnit.SESSION_SECOND, 2000),
      rollup(18, AiCapability.STT, AiUsageUnit.SESSION_SECOND, 2200),
      rollup(3, AiCapability.STT, AiUsageUnit.AUDIO_SECOND, 1990), // streaming echo — never billable
      rollup(10, AiCapability.LLM, AiUsageUnit.INPUT_TOKEN, 900_000),
      rollup(22, AiCapability.LLM, AiUsageUnit.INPUT_TOKEN, 400_000),
      rollup(22, AiCapability.LLM, AiUsageUnit.OUTPUT_TOKEN, 100_000),
      rollup(20, AiCapability.TTS, AiUsageUnit.CHARACTER, 50_000),
    ]),
  };

  const usageAggregateRepository = {
    sumDailyQuantitiesByOperation: vi.fn(async (query: { capability: AiCapability }) =>
      query.capability === AiCapability.LLM
        ? [
            {
              day: day(10),
              unit: AiUsageUnit.INPUT_TOKEN,
              operation: 'guardrail.validate',
              // Must match the rollup bucket it deducts from (TASK-638 key).
              provider: 'test',
              deployment: AiDeploymentKind.SELF_HOSTED,
              quantity: new Decimal(200_000),
            },
          ]
        : [],
    ),
    sumByokNotionalCostMicros: vi.fn(async () => 555_555n),
  };

  const planEntitlementRepository = {
    findByPlan: vi.fn(async () => ({
      monthlySttSessionSeconds: 3600n,
      monthlyLlmTokens: 1_000_000n,
      monthlyTtsCharacters: 100_000n,
    })),
  };
  const tenantEntitlementRepository = { findByTenant: vi.fn(async () => null) };
  const tenantRepository = {
    findById: vi.fn(async () => new TenantEntity({ id: TENANT, name: 'T', code: 'T', plan: TenantPlan.PRO } as never)),
  };

  const sellRates = new Map<AiUsageUnit, bigint>([
    [AiUsageUnit.SESSION_SECOND, 6n],
    [AiUsageUnit.AUDIO_SECOND, 6n],
    [AiUsageUnit.INPUT_TOKEN, 2n],
    [AiUsageUnit.OUTPUT_TOKEN, 6n],
    [AiUsageUnit.CHARACTER, 2n],
  ]);
  const priceBook = {
    resolveSellPrice: vi.fn(async (input: { unit: AiUsageUnit }) => {
      const rate = sellRates.get(input.unit);
      return rate === undefined ? null : { priceBookId: `sell-${input.unit}`, unitPriceMicros: rate, bookVersion: 'sim-book-v1', currency: 'USD' };
    }),
    resolvePlanFee: vi.fn(async () => ({ priceBookId: 'fee-pro', unitPriceMicros: 999_000_000n, bookVersion: 'sim-book-v1', currency: 'USD' })),
    resolveCostPrice: vi.fn(),
    resolveUsagePrice: vi.fn(),
  };

  // No plan-change history in the simulated month → single PERIOD_END_PLAN segment.
  const planHistoryRepository = {
    findOverlappingPeriod: vi.fn(async () => []),
    findOpenWindow: vi.fn(async () => null),
    update: vi.fn(),
    create: vi.fn(),
  };

  const unitOfWork = { runInTransaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work({})) };
  const eventEmitter = { emit: vi.fn() };
  const cls = { get: vi.fn((key: string) => (key === 'user' ? { id: 'admin-1', roles: ['GLOBAL_ADMIN'] } : TENANT)) };

  const service = new BillingService(
    eventEmitter as never,
    cls as never,
    invoiceRepository as never,
    lineRepository as never,
    adjustmentRepository as never,
    rollupRepository as never,
    usageAggregateRepository as never,
    planEntitlementRepository as never,
    tenantEntitlementRepository as never,
    tenantRepository as never,
    planHistoryRepository as never,
    priceBook as never,
    unitOfWork as never,
  );

  return { service };
}
