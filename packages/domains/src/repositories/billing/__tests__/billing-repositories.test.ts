import Decimal from 'decimal.js';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { BillingInvoiceLineFactory } from '../../../factories';
import { AiCapability, AiUsageUnit, BillingLineKind, ResourceStatusType } from '../../../enums';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { BillingUsageAggregateRepository } from '../BillingUsageAggregateRepository';
import { BillingInvoiceLineWriteRepository } from '../BillingInvoiceLineWriteRepository';

/**
 * TASK-615 WS-I — hand-written billing repository extensions.
 *
 * `BillingUsageAggregateRepository` runs bounded SQL AGGREGATES over the raw
 * ledger (sums, never row reads) for the two things the rollups cannot answer:
 * operation-discriminated quantities (D16/OQ1) and the BYOK notional cost sum
 * (D14). `BillingInvoiceLineWriteRepository` adds the bulk PREDICATE soft-delete
 * the draft recompute needs (base `softDelete` takes a single id); its insert
 * half is the base `createMany(entities, false, tx)`.
 */

const TENANT = '11111111-1111-1111-1111-111111111111';
const FROM = new Date('2026-08-01T00:00:00.000Z');
const TO = new Date('2026-09-01T00:00:00.000Z');

function fakeUow(client: unknown): CoreUnitOfWorkService {
  return { getDatabaseService: () => client } as unknown as CoreUnitOfWorkService;
}

describe('BillingUsageAggregateRepository.sumDailyQuantitiesByOperation', () => {
  it('maps day/unit/operation rows and parses quantities as Decimal', async () => {
    const queryRaw = vi.fn().mockResolvedValue([
      { day: new Date('2026-08-03T00:00:00.000Z'), unit: 'INPUT_TOKEN', operation: 'guardrail.validate', quantity: '123.456789' },
      { day: new Date('2026-08-04T00:00:00.000Z'), unit: 'OUTPUT_TOKEN', operation: 'harness.step', quantity: 42 },
    ]);
    const repo = new BillingUsageAggregateRepository(fakeUow({ $queryRaw: queryRaw }));

    const rows = await repo.sumDailyQuantitiesByOperation({
      tenantId: TENANT,
      capability: AiCapability.LLM,
      operations: ['guardrail.validate', 'harness.step'],
      from: FROM,
      to: TO,
    });

    expect(rows).toHaveLength(2);
    expect(rows[0].day.toISOString()).toBe('2026-08-03T00:00:00.000Z');
    expect(rows[0].unit).toBe(AiUsageUnit.INPUT_TOKEN);
    expect(rows[0].operation).toBe('guardrail.validate');
    expect(rows[0].quantity).toBeInstanceOf(Decimal);
    expect(rows[0].quantity.toFixed(6)).toBe('123.456789');
    expect(rows[1].quantity.toNumber()).toBe(42);

    // Every dimension is a BOUND PARAMETER, never string-interpolated SQL.
    const sqlArg = queryRaw.mock.calls[0][0];
    expect(sqlArg.values).toEqual(expect.arrayContaining([TENANT, 'LLM', 'guardrail.validate', 'harness.step', FROM, TO]));
  });

  it('returns [] without querying when no operations are requested', async () => {
    const queryRaw = vi.fn();
    const repo = new BillingUsageAggregateRepository(fakeUow({ $queryRaw: queryRaw }));
    const rows = await repo.sumDailyQuantitiesByOperation({ tenantId: TENANT, capability: AiCapability.STT, operations: [], from: FROM, to: TO });
    expect(rows).toEqual([]);
    expect(queryRaw).not.toHaveBeenCalled();
  });
});

describe('BillingUsageAggregateRepository.sumByokNotionalCostMicros', () => {
  it('returns the notional sum as bigint', async () => {
    const queryRaw = vi.fn().mockResolvedValue([{ sum: 123456789n }]);
    const repo = new BillingUsageAggregateRepository(fakeUow({ $queryRaw: queryRaw }));
    await expect(repo.sumByokNotionalCostMicros(TENANT, FROM, TO)).resolves.toBe(123456789n);
    expect(queryRaw.mock.calls[0][0].values).toEqual(expect.arrayContaining([TENANT, FROM, TO]));
  });

  it('degrades a NULL sum (no BYOK rows) to 0n', async () => {
    const queryRaw = vi.fn().mockResolvedValue([{ sum: null }]);
    const repo = new BillingUsageAggregateRepository(fakeUow({ $queryRaw: queryRaw }));
    await expect(repo.sumByokNotionalCostMicros(TENANT, FROM, TO)).resolves.toBe(0n);
  });
});

describe('BillingInvoiceLineWriteRepository', () => {
  const line = BillingInvoiceLineFactory.CreateBillingInvoiceLine({
    tenantId: TENANT,
    invoiceId: 'inv-1',
    kind: BillingLineKind.OVERAGE,
    capability: AiCapability.STT,
    unit: AiUsageUnit.SESSION_SECOND,
    amountMicros: 3000n,
    description: 'STT SESSION_SECOND overage',
  });

  let tx: { billingInvoiceLine: { updateMany: ReturnType<typeof vi.fn>; createMany: ReturnType<typeof vi.fn> } };
  let repo: BillingInvoiceLineWriteRepository;

  beforeEach(() => {
    tx = { billingInvoiceLine: { updateMany: vi.fn().mockResolvedValue({ count: 1 }), createMany: vi.fn().mockResolvedValue({ count: 1 }) } };
    repo = new BillingInvoiceLineWriteRepository(fakeUow({ billingInvoiceLine: {} }));
  });

  it("softDeleteByInvoice soft-deletes the invoice's live lines through the supplied tx (never hard-deletes)", async () => {
    await repo.softDeleteByInvoice(TENANT, 'inv-1', 'user-1', tx as never);

    expect(tx.billingInvoiceLine.updateMany).toHaveBeenCalledTimes(1);
    const args = tx.billingInvoiceLine.updateMany.mock.calls[0][0];
    expect(args.where).toEqual({ tenantId: TENANT, invoiceId: 'inv-1', resourceStatus: { not: ResourceStatusType.DELETED } });
    expect(args.data.resourceStatus).toBe(ResourceStatusType.DELETED);
    expect(args.data.resourceStatusUpdatedBy).toBe('user-1');
    expect(args.data.resourceStatusUpdatedAt).toBeInstanceOf(Date);
    // Soft-delete is a real state change — `_version` must bump (OCC).
    expect(args.data.version).toEqual({ increment: 1 });
  });

  // The insert half of the supersede is the BASE `createMany(entities, false, tx)` —
  // this repository adds no insert of its own. Covered here because the recompute
  // depends on the base honouring the tx and the `_version` strip for these rows.
  it('base createMany maps entities through the house mapper and writes through the tx', async () => {
    await repo.createMany([line], false, tx as never);

    expect(tx.billingInvoiceLine.createMany).toHaveBeenCalledTimes(1);
    const args = tx.billingInvoiceLine.createMany.mock.calls[0][0];
    expect(args.data).toHaveLength(1);
    expect(args.data[0].id).toBe(line.id);
    expect(args.data[0].amountMicros).toBe(3000n);
    // Supersede inserts a fresh set — a duplicate id is a bug, never a skip.
    expect(args.skipDuplicates).toBe(false);
    // The OCC strip: `_version` is database-owned and must not be written.
    expect(args.data[0]).not.toHaveProperty('version');
  });

  it('base createMany is a no-op for an empty batch', async () => {
    await repo.createMany([], false, tx as never);
    expect(tx.billingInvoiceLine.createMany).not.toHaveBeenCalled();
  });
});
