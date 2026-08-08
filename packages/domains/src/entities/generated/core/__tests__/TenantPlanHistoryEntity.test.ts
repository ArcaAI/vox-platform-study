/**
 * TenantPlanHistory entity/factory behavior (TASK-615 #6 — plan-fee proration).
 *
 * Locks the append-only lifecycle: a window is opened by the factory
 * (`effectiveTo` defaults to null = in force), closed exactly once via
 * `supersedeAt()`, and never edited in place. `validate()` is the structural
 * backstop (plan + effectiveFrom required; window never inverted). Setters
 * route through `setProperty` so `repository.update` persists only
 * `entity.changes`.
 */
import { describe, it, expect } from 'vitest';
import { TenantPlanHistoryFactory } from '../../../../factories/generated/core/TenantPlanHistoryFactory';
import { TenantPlanHistoryEntity } from '../TenantPlanHistoryEntity';
import * as Enums from '../../../../enums';

const FROM = new Date('2026-08-01T00:00:00.000Z');

describe('TenantPlanHistoryEntity', () => {
  it('factory: generated id, tenant scope, open window (effectiveTo null), no changes', () => {
    const entity = TenantPlanHistoryFactory.CreateTenantPlanHistory({
      tenantId: 't-1',
      plan: Enums.TenantPlan.STARTER,
      effectiveFrom: FROM,
    });

    expect(entity.id).toBeTruthy();
    expect(entity.tenantId).toBe('t-1');
    expect(entity.plan).toBe(Enums.TenantPlan.STARTER);
    expect(entity.effectiveFrom).toEqual(FROM);
    expect(entity.effectiveTo).toBeNull();
    expect(entity.previousPlan).toBeNull();
    expect(entity.changeReason).toBeNull();
    expect(entity.hasChanges).toBe(false);
  });

  it('factory: carries previousPlan + changeReason through', () => {
    const entity = TenantPlanHistoryFactory.CreateTenantPlanHistory({
      tenantId: 't-1',
      plan: Enums.TenantPlan.STARTER,
      previousPlan: Enums.TenantPlan.TRIAL,
      effectiveFrom: FROM,
      changeReason: 'upgrade',
    });

    expect(entity.previousPlan).toBe(Enums.TenantPlan.TRIAL);
    expect(entity.changeReason).toBe('upgrade');
  });

  it('supersedeAt: closes the open window (change-tracked) and validates', () => {
    const entity = TenantPlanHistoryFactory.CreateTenantPlanHistory({
      tenantId: 't-1',
      plan: Enums.TenantPlan.STARTER,
      effectiveFrom: FROM,
    });
    const at = new Date('2026-08-15T00:00:00.000Z');

    entity.supersedeAt(at);

    expect(entity.effectiveTo).toEqual(at);
    expect(entity.hasChanges).toBe(true);
    expect(entity.changes).toHaveProperty('effectiveTo');
    expect(() => entity.validate()).not.toThrow();
  });

  it('supersedeAt: rejects closing an already-closed window', () => {
    const entity = TenantPlanHistoryFactory.CreateTenantPlanHistory({
      tenantId: 't-1',
      plan: Enums.TenantPlan.STARTER,
      effectiveFrom: FROM,
      effectiveTo: new Date('2026-08-10T00:00:00.000Z'),
    });

    expect(() => entity.supersedeAt(new Date('2026-08-20T00:00:00.000Z'))).toThrow();
  });

  it('supersedeAt: rejects an effectiveTo before effectiveFrom', () => {
    const entity = TenantPlanHistoryFactory.CreateTenantPlanHistory({
      tenantId: 't-1',
      plan: Enums.TenantPlan.STARTER,
      effectiveFrom: FROM,
    });

    expect(() => entity.supersedeAt(new Date('2026-07-01T00:00:00.000Z'))).toThrow();
  });

  it('validate: rejects an inverted window', () => {
    const entity = TenantPlanHistoryFactory.CreateTenantPlanHistory({
      tenantId: 't-1',
      plan: Enums.TenantPlan.STARTER,
      effectiveFrom: FROM,
      effectiveTo: new Date('2026-07-01T00:00:00.000Z'),
    });

    expect(() => entity.validate()).toThrow();
  });
});
