/**
 * TenantEntity lifecycle + plan field
 *
 * TDD verification for:
 *   - #3 the new nullable `plan` (TenantPlan) field on the entity + factory
 *   - #1 the `suspend()` transition (ResourceStatusType.SUSPENDED) alongside the
 *     inherited archive()/enable() transitions used by the service lifecycle.
 */
import { describe, it, expect } from 'vitest';
import { TenantEntity, ITenantEntity } from '../generated/core/TenantEntity';
import { TenantFactory } from '../../factories/generated/core/TenantFactory';
import { ResourceStatusType, TenantPlan } from '../../enums';

function createInit(overrides: Partial<ITenantEntity> = {}): ITenantEntity {
  return {
    id: 'tenant-test-id',
    name: 'Acme Corp',
    key: 'ACME',
    description: 'A test tenant',
    tags: [],
    createdAt: new Date('2026-01-01'),
    updatedAt: new Date('2026-01-01'),
    createdBy: 'user-1',
    updatedBy: null,
    resourceStatus: ResourceStatusType.ENABLED,
    resourceStatusUpdatedAt: null,
    resourceStatusUpdatedBy: null,
    metaData: undefined,
    version: 1,
    ...overrides,
  } as ITenantEntity;
}

describe('TenantEntity — plan field', () => {
  it('accepts a plan in the constructor', () => {
    const entity = new TenantEntity(createInit({ plan: TenantPlan.ENTERPRISE }));
    expect(entity.plan).toBe(TenantPlan.ENTERPRISE);
  });

  it('defaults to undefined when not provided', () => {
    const entity = new TenantEntity(createInit());
    expect(entity.plan).toBeUndefined();
  });

  it('tracks a change when set via the setter', () => {
    const entity = new TenantEntity(createInit({ plan: null }));
    entity.plan = TenantPlan.PRO;

    expect(entity.plan).toBe(TenantPlan.PRO);
    expect(entity.hasChanges).toBe(true);
    expect(entity.changes).toHaveProperty('plan', TenantPlan.PRO);
  });

  it('factory carries plan and defaults it to null', () => {
    const withPlan = TenantFactory.CreateTenant({ name: 'Beta', key: 'BETA', plan: TenantPlan.TRIAL });
    expect(withPlan.plan).toBe(TenantPlan.TRIAL);

    const withoutPlan = TenantFactory.CreateTenant({ name: 'Gamma', key: 'GAMMA' });
    expect(withoutPlan.plan).toBeNull();
  });
});

describe('TenantEntity — lifecycle transitions', () => {
  it('suspend() moves the tenant to SUSPENDED and records the actor', () => {
    const entity = new TenantEntity(createInit());
    entity.clearChanges();

    entity.suspend('operator-1');

    expect(entity.resourceStatus).toBe(ResourceStatusType.SUSPENDED);
    expect(entity.resourceStatusUpdatedBy).toBe('operator-1');
    expect(entity.hasChanges).toBe(true);
    expect(entity.changes).toHaveProperty('resourceStatus', ResourceStatusType.SUSPENDED);
  });

  it('archive() then enable() round-trips back to ENABLED', () => {
    const entity = new TenantEntity(createInit());

    entity.archive('operator-1');
    expect(entity.resourceStatus).toBe(ResourceStatusType.ARCHIVED);

    entity.enable('operator-2');
    expect(entity.resourceStatus).toBe(ResourceStatusType.ENABLED);
  });
});
