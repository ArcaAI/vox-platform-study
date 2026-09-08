/**
 * TASK-932 R-4 / R-8 — the feature-availability routes.
 *
 * The controller is thin on purpose (the service owns the cascade and the
 * matrix), so what is worth pinning here is the CALLER SCOPING of the effective
 * read: which tenant a given caller is asking about. Get that wrong and a
 * platform admin with a tenant selected sees the platform's own gates instead of
 * that tenant's, or an unscoped one falls back to a customer tenant -- which
 * would be a cross-tenant leak however local it looks (rule 00).
 */
import { describe, expect, it, vi } from 'vitest';
import type { FeatureAvailabilityService } from '@arcaai/applications';
import { SettingsFeaturesController } from '../settings-features.controller';

function controllerFor(user: unknown, clsTenantId?: string) {
  const cls = { get: (key: string) => (key === 'user' ? user : key === 'tenantId' ? clsTenantId : undefined) } as never;
  const features = {
    resolveEffectiveForTenant: vi.fn(() => [{ key: 'console.mlflow.enabled', value: false, sourceScope: 'default' as const }]),
    readMatrix: vi.fn(async () => ({ features: [], tenants: [], cells: [] })),
    applyMatrix: vi.fn(async () => ({ cells: [], errors: [] })),
  } as unknown as FeatureAvailabilityService;
  return { controller: new SettingsFeaturesController(cls, features), features };
}

const superAdmin = { roles: ['SUPER_ADMIN'] };
const tenantAdmin = { roles: ['TENANT_ADMIN'], tenantId: 'tnt-self' };

describe('GET admin/settings/features/effective', () => {
  it('an UNSCOPED platform admin asks about the platform tier, never about a customer tenant', () => {
    // A missing tenant context resolves SYSTEM. Falling back to a customer
    // tenant here -- "Global" included -- would serve one customer's gates to
    // everyone (rule 00, the two reserved tenants).
    const { controller, features } = controllerFor(superAdmin);
    controller.getEffectiveFeatures();
    expect(features.resolveEffectiveForTenant).toHaveBeenCalledWith(null);
  });

  it('a platform admin WITH a working tenant asks about that tenant', () => {
    const { controller, features } = controllerFor(superAdmin, 'tnt-working');
    controller.getEffectiveFeatures();
    expect(features.resolveEffectiveForTenant).toHaveBeenCalledWith('tnt-working');
  });

  it('a tenant admin asks about its own tenant', () => {
    const { controller, features } = controllerFor(tenantAdmin, 'tnt-self');
    controller.getEffectiveFeatures();
    expect(features.resolveEffectiveForTenant).toHaveBeenCalledWith('tnt-self');
  });

  it('falls back to the JWT tenant when CLS carries none', () => {
    const { controller, features } = controllerFor(tenantAdmin);
    controller.getEffectiveFeatures();
    expect(features.resolveEffectiveForTenant).toHaveBeenCalledWith('tnt-self');
  });

  it('serves a tenant admin although every feature descriptor is globalOnly', () => {
    // Deliberate, and documented in the route's AUTH-NOTE: these are VALUES
    // about the caller's own tenant, not the descriptor inventory. Withholding
    // them would not protect anything -- it would only make the console's
    // navigation wrong.
    const { controller } = controllerFor(tenantAdmin, 'tnt-self');
    expect(controller.getEffectiveFeatures().items.length).toBeGreaterThan(0);
  });
});

describe('the matrix routes', () => {
  it('delegate the SUPER_ADMIN gate to the service, so read and write cannot drift', async () => {
    // The privilege rule lives in one place (`assertPlatformMatrixAccess`); the
    // controller must not grow a second copy that could disagree with it.
    const { controller, features } = controllerFor(superAdmin);
    await controller.getFeatureMatrix();
    await controller.putFeatureMatrix({ cells: [{ key: 'console.mlflow.enabled', tenantId: 'system', value: true }] });
    expect(features.readMatrix).toHaveBeenCalled();
    expect(features.applyMatrix).toHaveBeenCalled();
  });

  it('normalises an omitted expectedVersion away rather than passing undefined through', async () => {
    const { controller, features } = controllerFor(superAdmin);
    await controller.putFeatureMatrix({
      cells: [
        { key: 'console.mlflow.enabled', tenantId: 'system', value: true },
        { key: 'console.tools.mcp.enabled', tenantId: 't-1', value: null, expectedVersion: 3 },
      ],
    });
    expect(features.applyMatrix).toHaveBeenCalledWith([
      { key: 'console.mlflow.enabled', tenantId: 'system', value: true },
      { key: 'console.tools.mcp.enabled', tenantId: 't-1', value: null, expectedVersion: 3 },
    ]);
  });
});
