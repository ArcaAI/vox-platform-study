/**
 * TenantFactory trial-clock stamping.
 *
 * A tenant created on the TRIAL plan gets a 7-day trial window stamped from
 * `createdAt`; non-TRIAL tenants carry a null clock; an explicit `trialEndsAt`
 * always wins. The plan default itself stays `null` (factory
 * contract, covered by TenantEntity.lifecycle-plan.test.ts).
 */
import { describe, it, expect } from 'vitest';
import { TenantFactory } from '../TenantFactory';
import { TenantPlan } from '../../../../enums';

const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

describe('TenantFactory — trial clock (TASK-392 Q4)', () => {
  it('stamps trialEndsAt = createdAt + 7 days for a TRIAL tenant', () => {
    const createdAt = new Date('2026-01-01T00:00:00.000Z');
    const tenant = TenantFactory.CreateTenant({ name: 'Trial Co', key: 'TRIALCO', plan: TenantPlan.TRIAL, createdAt });

    expect(tenant.plan).toBe(TenantPlan.TRIAL);
    expect(tenant.trialEndsAt).toEqual(new Date(createdAt.getTime() + SEVEN_DAYS_MS));
  });

  it('leaves trialEndsAt null for a non-TRIAL plan', () => {
    const enterprise = TenantFactory.CreateTenant({ name: 'Ent Co', key: 'ENTCO', plan: TenantPlan.ENTERPRISE });
    expect(enterprise.trialEndsAt).toBeNull();
  });

  it('leaves trialEndsAt null when no plan is supplied (plan stays null)', () => {
    const legacy = TenantFactory.CreateTenant({ name: 'Legacy Co', key: 'LEGACYCO' });
    expect(legacy.plan).toBeNull();
    expect(legacy.trialEndsAt).toBeNull();
  });

  it('honors an explicit trialEndsAt over the default window', () => {
    const explicitEnd = new Date('2026-03-01T00:00:00.000Z');
    const tenant = TenantFactory.CreateTenant({ name: 'Trial Co', key: 'TRIALCO2', plan: TenantPlan.TRIAL, trialEndsAt: explicitEnd });
    expect(tenant.trialEndsAt).toEqual(explicitEnd);
  });
});
