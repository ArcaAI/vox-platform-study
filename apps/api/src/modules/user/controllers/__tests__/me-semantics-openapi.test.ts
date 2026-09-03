/**
 * the `me` semantics, documented rather than merely implemented.
 *
 * `UnifiedAuthGuard.handleApiKeyAuth` sets the CLS principal from the KEY'S
 * BOUND USER (`apiKeyEntity.userId`) and the CLS tenant from the key's tenant.
 * So once policy A1 makes these surfaces API-key reachable, `me` means two
 * DIFFERENT things depending on the route:
 *
 *   - `/user/me/*` (and the self-only `users/:id/roles`) → the BOUND USER.
 *     An unbound `SERVICE_ACCOUNT` key cannot call them at all:
 *     `enforceApiKeyAbilities` refuses a key with no `userId` on any
 *     permissioned route.
 *   - the bare "mine" surfaces (`billing`, `usage`, `entitlements`, `tenant`)
 *     → the key's TENANT.
 *
 * An integrator reading `summary: 'Get current user preferences'` will assume
 * "my tenant". Nothing in the path distinguishes the two, so the distinction
 * has to be in the OpenAPI `description` — which is what this spec pins, per
 * route, so a future edit cannot quietly drop it.
 *
 * `UserPreferencesController` is included even though it was API-key reachable
 * BEFORE (`user:preferences:write`): it is the surface
 * that proves the ambiguity, and leaving the one already-keyed `me` route
 * undocumented would be the exact gap A1 is closing.
 */
import { describe, it, expect } from 'vitest';

import { UserPreferencesController } from '../user-preferences.controller';
import { UserSettingsController } from '../user-settings.controller';
import { UserDepartmentsMeController } from '../user-departments-me.controller';
import { UserRolesController } from '../user-roles.controller';
import { MyBillingController } from '../../../billing/my-billing.controller';
import { MyUsageController } from '../../../admin-usage/my-usage.controller';
import { MyEntitlementsController } from '../../../entitlements/my-entitlements.controller';
import { MyTenantController } from '../../../tenant/my-tenant.controller';
import { MyTenantContextSchemaController } from '../../../consultation-context-schema/consultation-context-schema.controller';

/** The key `@ApiOperation()` writes; read directly so no swagger scan is needed. */
const API_OPERATION = 'swagger/apiOperation';

function description(ControllerClass: { prototype: Record<string, unknown> }, method: string): string {
  const meta = Reflect.getMetadata(API_OPERATION, ControllerClass.prototype[method] as object) as { description?: string } | undefined;
  return meta?.description ?? '';
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- controller classes are only ever read for metadata here
type Ctor = any;

const BOUND_USER_ROUTES: Array<[string, Ctor, string]> = [
  ['UserPreferencesController.getPreferences', UserPreferencesController, 'getPreferences'],
  ['UserPreferencesController.updatePreferences', UserPreferencesController, 'updatePreferences'],
  ['UserSettingsController.getMySettings', UserSettingsController, 'getMySettings'],
  ['UserSettingsController.updateSetting', UserSettingsController, 'updateSetting'],
  ['UserDepartmentsMeController.myDepartments', UserDepartmentsMeController, 'myDepartments'],
  ['UserRolesController.listMyRoleAssignments', UserRolesController, 'listMyRoleAssignments'],
];

const TENANT_ROUTES: Array<[string, Ctor, string]> = [
  ['MyBillingController.listMine', MyBillingController, 'listMine'],
  ['MyBillingController.getMine', MyBillingController, 'getMine'],
  ['MyBillingController.spend', MyBillingController, 'spend'],
  ['MyUsageController.summary', MyUsageController, 'summary'],
  ['MyUsageController.burndown', MyUsageController, 'burndown'],
  ['MyEntitlementsController.me', MyEntitlementsController, 'me'],
  ['MyTenantController.me', MyTenantController, 'me'],
  ['MyTenantController.myConfig', MyTenantController, 'myConfig'],
  ['MyTenantController.updateMyConfig', MyTenantController, 'updateMyConfig'],
  // `tenant/me/context-schema` is TENANT-scoped (`getEffectiveBundle` resolves
  // `requireTenantId()`), so it takes the tenant sentence — the ticket's Step 8
  // grouped it with the `/user/me/*` surfaces, which would have told an
  // integrator the opposite of what the service does.
  ['MyTenantContextSchemaController.getEffective', MyTenantContextSchemaController, 'getEffective'],
];

describe('`me` semantics under API-key auth are documented in OpenAPI', () => {
  it.each(BOUND_USER_ROUTES)('%s says `me` is the key\'s BOUND USER', (_name, ControllerClass, method) => {
    const text = description(ControllerClass, method);
    expect(text).toContain('bound to');
    // The unbound-key consequence is the half an integrator cannot infer.
    expect(text).toMatch(/SERVICE_ACCOUNT/);
  });

  it.each(TENANT_ROUTES)("%s says it resolves to the key's TENANT", (_name, ControllerClass, method) => {
    const text = description(ControllerClass, method);
    expect(text).toMatch(/resolves to the key's \*\*tenant\*\*/);
  });

  it('never tells a bound-user route that it resolves to the tenant, or vice versa', () => {
    for (const [, ControllerClass, method] of BOUND_USER_ROUTES) {
      expect(description(ControllerClass, method)).not.toMatch(/resolves to the key's \*\*tenant\*\*/);
    }
    for (const [, ControllerClass, method] of TENANT_ROUTES) {
      expect(description(ControllerClass, method)).not.toContain('bound to');
    }
  });
});
