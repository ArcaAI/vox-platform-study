import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BusinessException } from '@arcaai/exceptions';
import { ForbiddenException } from '@nestjs/common';
import {
  AiCapability,
  AiPriceBookEntity,
  AiPriceBookFactory,
  AiPriceBookPlane,
  AiPriceRowKind,
  AiUsageUnit,
  SYSTEM_TENANT_ID,
  SysEventType,
  TenantPlan,
} from '@arcaai/domains';

import { SellRateCardService } from '../sell-rate-card.service';
import { CreateSellRateRequest, SupersedeSellRateRequest } from '../dto';

/**
 * Golden (i) — the supersede-only SELL rate card.
 *
 * A price is NEVER edited in place: repricing closes the current row
 * (`effectiveTo` = successor's `effectiveFrom`) and inserts the successor,
 * atomically, in ONE transaction. The service exposes NO update method at all
 * — absence of the mutation path is part of the contract and is asserted.
 */

const SUPER_ADMIN = { id: 'admin-1', roles: ['SUPER_ADMIN'] };
const TENANT_ADMIN = { id: 'user-1', roles: ['TENANT_ADMIN'], tenantId: 'tenant-1' };

function makeService(user: unknown = SUPER_ADMIN) {
  const rows = new Map<string, AiPriceBookEntity>();
  const txMarker = { tx: true };

  const repository = {
    create: vi.fn(async (entity: AiPriceBookEntity, _tx?: unknown) => {
      rows.set(entity.id, entity);
      return entity;
    }),
    findById: vi.fn(async (id: string) => {
      const row = rows.get(id);
      if (!row) throw new Error(`not found: ${id}`);
      return row;
    }),
    findAll: vi.fn(async () => [...rows.values()]),
    updateWithVersion: vi.fn(async (id: string, entity: AiPriceBookEntity, expectedVersion: number, _tx?: unknown) => {
      const current = rows.get(id)!;
      if (current.version !== expectedVersion) {
        const err = new Error('version drift') as Error & { name: string };
        err.name = 'OptimisticConcurrencyException';
        throw err;
      }
      rows.set(id, entity);
      return entity;
    }),
  };

  const unitOfWork = {
    runInTransaction: vi.fn(async (work: (tx: unknown) => Promise<unknown>) => work(txMarker)),
  };

  const eventEmitter = { emit: vi.fn() };
  const cls = {
    get: vi.fn((key: string) => {
      if (key === 'user') return user;
      if (key === 'tenantId') return (user as { tenantId?: string })?.tenantId ?? '';
      return undefined;
    }),
  };

  const service = new SellRateCardService(
    eventEmitter as never,
    cls as never,
    repository as never,
    unitOfWork as never,
  );

  return { service, repository, unitOfWork, eventEmitter, rows, txMarker };
}

const baseCreate: CreateSellRateRequest = Object.assign(new CreateSellRateRequest(), {
  rowKind: AiPriceRowKind.USAGE_UNIT,
  capability: AiCapability.STT,
  unit: AiUsageUnit.SESSION_SECOND,
  unitPriceMicros: '6',
  effectiveFrom: '2026-09-01T00:00:00.000Z',
  bookVersion: '2026-09-01-v2',
});

describe('SellRateCardService.createSellRate', () => {
  it('creates a SYSTEM-owned, SELL-plane row and broadcasts ResourceCreated', async () => {
    const { service, repository, eventEmitter } = makeService();

    const response = await service.createSellRate(baseCreate);

    expect(repository.create).toHaveBeenCalledTimes(1);
    const entity = repository.create.mock.calls[0][0] as AiPriceBookEntity;
    expect(entity.plane).toBe(AiPriceBookPlane.SELL); // the service PINS the plane
    expect(entity.tenantId).toBe(SYSTEM_TENANT_ID); // platform card by default
    expect(entity.effectiveTo).toBeNull(); // open-ended until superseded
    expect(response.unitPriceMicros).toBe('6');
    expect(eventEmitter.emit).toHaveBeenCalledWith(SysEventType.ResourceCreated, expect.objectContaining({ resourceId: entity.id }));
  });

  it('accepts a tenant-owned row (negotiated enterprise card)', async () => {
    const { service, repository } = makeService();
    await service.createSellRate(Object.assign(new CreateSellRateRequest(), baseCreate, { tenantId: 'tenant-42' }));
    expect((repository.create.mock.calls[0][0] as AiPriceBookEntity).tenantId).toBe('tenant-42');
  });

  it('rejects a PLAN_FEE row carrying capability/unit, and one missing planTier', async () => {
    const { service } = makeService();
    await expect(
      service.createSellRate(Object.assign(new CreateSellRateRequest(), baseCreate, { rowKind: AiPriceRowKind.PLAN_FEE, planTier: TenantPlan.PRO })),
    ).rejects.toThrow(/PLAN_FEE/);
    await expect(
      service.createSellRate(
        Object.assign(new CreateSellRateRequest(), { rowKind: AiPriceRowKind.PLAN_FEE, unitPriceMicros: '1', effectiveFrom: '2026-09-01T00:00:00.000Z', bookVersion: 'v' }),
      ),
    ).rejects.toThrow(/planTier/);
  });

  it('rejects a USAGE_UNIT row without capability + unit', async () => {
    const { service } = makeService();
    await expect(
      service.createSellRate(Object.assign(new CreateSellRateRequest(), baseCreate, { unit: undefined })),
    ).rejects.toThrow(/unit/);
  });

  // AUTH-NOTE pattern (rule 05): the decorator cannot express "global admins
  // only", so the SERVICE is the real gate — a deliberate 403 privilege
  // boundary, not the 404-over-403 tenancy posture.
  it('is SUPER_ADMIN-only — a tenant admin gets 403', async () => {
    const { service } = makeService(TENANT_ADMIN);
    await expect(service.createSellRate(baseCreate)).rejects.toThrow(ForbiddenException);
  });
});

describe('SellRateCardService.supersedeSellRate', () => {
  function seedOpenRow(rows: Map<string, AiPriceBookEntity>): AiPriceBookEntity {
    const row = AiPriceBookFactory.CreateAiPriceBook({
      tenantId: SYSTEM_TENANT_ID,
      plane: AiPriceBookPlane.SELL,
      rowKind: AiPriceRowKind.USAGE_UNIT,
      capability: AiCapability.STT,
      unit: AiUsageUnit.SESSION_SECOND,
      unitPriceMicros: 6n,
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      bookVersion: 'v1',
    });
    rows.set(row.id, row);
    return row;
  }

  const supersedeRequest: SupersedeSellRateRequest = Object.assign(new SupersedeSellRateRequest(), {
    unitPriceMicros: '8',
    effectiveFrom: '2026-08-16T00:00:00.000Z',
    bookVersion: 'v2',
  });

  it('closes the old row and inserts the successor ATOMICALLY in one transaction', async () => {
    const { service, repository, unitOfWork, rows, txMarker, eventEmitter } = makeService();
    const oldRow = seedOpenRow(rows);

    const result = await service.supersedeSellRate(oldRow.id, supersedeRequest, 1);

    // Both writes rode the SAME tx client.
    expect(unitOfWork.runInTransaction).toHaveBeenCalledTimes(1);
    expect(repository.updateWithVersion).toHaveBeenCalledWith(oldRow.id, expect.anything(), 1, txMarker);
    expect(repository.create.mock.calls[0][1]).toBe(txMarker);

    // Windows abut exactly: old [Jan-01, Aug-16) · successor [Aug-16, ∞).
    expect(result.closed.effectiveTo).toBe('2026-08-16T00:00:00.000Z');
    expect(result.successor.effectiveFrom).toBe('2026-08-16T00:00:00.000Z');
    expect(result.successor.effectiveTo).toBeNull();
    expect(result.successor.unitPriceMicros).toBe('8');

    // Dimensions are INHERITED — a supersede reprices, it never re-shapes.
    expect(result.successor.capability).toBe(AiCapability.STT);
    expect(result.successor.unit).toBe(AiUsageUnit.SESSION_SECOND);
    expect(result.successor.planTier).toBeNull();

    // Both sides of the supersede are audited.
    expect(eventEmitter.emit).toHaveBeenCalledWith(SysEventType.ResourceUpdated, expect.objectContaining({ resourceId: oldRow.id }));
    expect(eventEmitter.emit).toHaveBeenCalledWith(SysEventType.ResourceCreated, expect.anything());
  });

  it('golden (i): MUTATION of an effective row is impossible — no update surface exists, and re-superseding a closed row throws', async () => {
    const { service, rows } = makeService();
    const oldRow = seedOpenRow(rows);
    await service.supersedeSellRate(oldRow.id, supersedeRequest, 1);

    // The service deliberately exposes NO in-place mutation method.
    expect((service as Record<string, unknown>)['updateSellRate']).toBeUndefined();
    expect((service as Record<string, unknown>)['update']).toBeUndefined();

    // A second supersede of the SAME row hits the entity's closed-window guard.
    await expect(service.supersedeSellRate(oldRow.id, supersedeRequest, 2)).rejects.toThrow(BusinessException);
  });

  it('rejects a successor starting before the old row started (window inversion)', async () => {
    const { service, rows } = makeService();
    const oldRow = seedOpenRow(rows);
    await expect(
      service.supersedeSellRate(oldRow.id, Object.assign(new SupersedeSellRateRequest(), supersedeRequest, { effectiveFrom: '2025-12-31T00:00:00.000Z' }), 1),
    ).rejects.toThrow(BusinessException);
  });

  it('refuses to touch a COST-plane row — this surface manages the SELL card only', async () => {
    const { service, rows } = makeService();
    const costRow = AiPriceBookFactory.CreateAiPriceBook({
      tenantId: SYSTEM_TENANT_ID,
      plane: AiPriceBookPlane.COST,
      capability: AiCapability.STT,
      unit: AiUsageUnit.AUDIO_SECOND,
      unitPriceMicros: 3n,
      effectiveFrom: new Date('2026-01-01T00:00:00.000Z'),
      bookVersion: 'cost-v1',
    });
    rows.set(costRow.id, costRow);
    await expect(service.supersedeSellRate(costRow.id, supersedeRequest, 1)).rejects.toThrow(/SELL/);
  });

  it('is SUPER_ADMIN-only', async () => {
    const { service, rows } = makeService(TENANT_ADMIN);
    const oldRow = seedOpenRow(rows);
    await expect(service.supersedeSellRate(oldRow.id, supersedeRequest, 1)).rejects.toThrow(ForbiddenException);
  });
});

describe('SellRateCardService.listSellRates', () => {
  it('lists SELL rows only, pinned by the filters', async () => {
    const { service, repository } = makeService();
    await service.listSellRates({});
    const props = repository.findAll.mock.calls[0][0] as { filters: Record<string, unknown> };
    expect(props.filters.plane).toBe(AiPriceBookPlane.SELL);
    expect(props.filters.tenantId).toBe(SYSTEM_TENANT_ID);
  });
});
