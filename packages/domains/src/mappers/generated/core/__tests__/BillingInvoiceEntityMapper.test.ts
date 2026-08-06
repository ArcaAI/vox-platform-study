/**
 * BillingInvoiceEntityMapper — OCC `_version` strip.
 *
 * `BillingInvoice` is the ONE new TASK-615 model that is optimistically
 * concurrency-controlled: a draft is edited (and then FINALIZED) through
 * versioned PATCH routes, so `_version` → strong ETag → `If-Match` →
 * `repository.updateWithVersion` is the whole immutability story for a closed
 * period. If the mapper let `version` reach a Prisma update, the DB-owned OCC
 * token would be overwritten by whatever the entity happened to hold and two
 * concurrent finalizes could BOTH succeed — one silently clobbering the other's
 * totals on a money document.
 *
 * This suite is the guard the `gen:mapper` generator is known to strip (it drops
 * FIELDS_NOT_WRITABLE and its helper before crashing — see rule 03; that command
 * must never be run). Mirrors `AiTaskDefaultEntityMapper.test.ts`.
 *
 * The append-only siblings (AiUsageEvent, rollups, BillingAdjustment) are NOT
 * OCC-written and strip `resourceStatus*` as well — see
 * `usage-billing.mappers.test.ts`.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect } from 'vitest';
import { BillingInvoiceEntityMapper } from '../BillingInvoiceEntityMapper';
import { BillingInvoice } from '../../../../models/generated/core/BillingInvoiceModel';
import { ResourceStatusType } from '../../../../enums/generated/ResourceStatusType';
import { BillingInvoiceStatus } from '../../../../enums/generated/BillingInvoiceStatus';

const sampleRow = (overrides: Partial<BillingInvoice> = {}): BillingInvoice =>
  new BillingInvoice({
    id: 'inv-1',
    tenantId: 't-1',
    periodStart: new Date('2026-08-01T00:00:00.000Z'),
    periodEnd: new Date('2026-09-01T00:00:00.000Z'),
    status: BillingInvoiceStatus.DRAFT,
    currency: 'USD',
    subtotalMicros: 12_500_000n,
    totalMicros: 12_500_000n,
    finalizedAt: null,
    finalizedBy: null,
    resourceStatus: ResourceStatusType.ENABLED,
    resourceStatusUpdatedAt: null,
    resourceStatusUpdatedBy: null,
    createdBy: null,
    updatedBy: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    version: 7,
    metaData: null,
    ...overrides,
  } as BillingInvoice);

describe('BillingInvoiceEntityMapper', () => {
  const mapper = new BillingInvoiceEntityMapper();

  it('toDomainEntity carries the money fields + `version` from the database row', () => {
    const entity = mapper.toDomainEntity(sampleRow());
    expect(entity.tenantId).toBe('t-1');
    expect(entity.status).toBe(BillingInvoiceStatus.DRAFT);
    expect(entity.subtotalMicros).toBe(12_500_000n);
    expect(entity.totalMicros).toBe(12_500_000n);
    expect(entity.version).toBe(7);
  });

  it('keeps money as integer micros (BigInt) — never a float', () => {
    const entity = mapper.toDomainEntity(sampleRow({ totalMicros: 9_007_199_254_740_993n }));
    // Beyond Number.MAX_SAFE_INTEGER: a float round-trip would lose the last digit.
    expect(entity.totalMicros).toBe(9_007_199_254_740_993n);
    expect(typeof entity.totalMicros).toBe('bigint');
    expect(mapper.toPersistence(entity).totalMicros).toBe(9_007_199_254_740_993n);
  });

  it('toPersistence (full insert path) does not write `version`', () => {
    const entity = mapper.toDomainEntity(sampleRow({ version: 1 }));
    expect(mapper.toPersistence(entity)).not.toHaveProperty('version');
  });

  it('toPersistenceChanges never contains `version`, even if the change set has it', () => {
    const entity = mapper.toDomainEntity(sampleRow());
    // simulate a buggy caller poking the internal change set
    (entity as any)._changes = { status: BillingInvoiceStatus.FINALIZED, version: 99 };
    const persisted = mapper.toPersistenceChanges(entity);
    expect(persisted).not.toHaveProperty('version');
    expect(persisted).toMatchObject({ status: BillingInvoiceStatus.FINALIZED });
  });
});
