/**
 * TASK-305 Phase B.7 — TenantContextProvider wiring.
 *
 * Adapter between `nestjs-cls` (which owns the request-scoped tenant id and
 * user roles) and the `tenantScopeFilter` Prisma extension shipped in
 * `@arcaai/database`. The extension calls `setTenantContextProvider(provider)`
 * at app bootstrap; the provider then exposes two lazy getters that the
 * extension invokes on every query.
 *
 * Semantics:
 *  - `getTenantId()`  — returns the active tenant id, or `undefined` when the
 *                       call site is outside any CLS context (startup hooks,
 *                       BullMQ workers without `cls.run()`, etc.). Outside-CLS
 *                       calls combined with `isSuperAdmin()=true` make the
 *                       extension behave as a pass-through, which is the
 *                       behaviour seed scripts and CLI tools depend on.
 *  - `isSuperAdmin()` — true when the current user's `roles` array contains
 *                       any `ELEVATED_ROLES` member (SUPER_ADMIN / GLOBAL_ADMIN),
 *                       OR when no CLS context exists at
 *                       all (system/startup path). The latter "no context =
 *                       super-admin" stance keeps the extension permissive in
 *                       contexts that haven't been wrapped in `cls.run()` yet;
 *                       Phase D will tighten this for queue workers and event
 *                       listeners.
 *
 * Intentionally tiny — no business logic lives here. All it does is read CLS.
 */

import { SUPER_ADMIN_ROLE } from '@arcaai/applications';
import type { IActiveUserContext } from '@arcaai/applications';
import { setTenantContextProvider, type TenantContextProvider } from '@arcaai/database';
import { Injectable, Logger, Module, OnApplicationBootstrap, OnApplicationShutdown } from '@nestjs/common';
import { ClsModule, ClsService } from 'nestjs-cls';

/**
 * AC-06 (TASK-336) — cross-tenant privileged roles for the DB-extension layer.
 * Local mirror of `@arcaai/applications` `ELEVATED_ROLES` (the canonical set
 * consumed by the `isSuperAdmin` helper). Kept local so this DB adapter has no
 * hard dependency on the applications elevated-set export, matching the same
 * deliberate cross-layer duplication documented in `common/tenant-guards.ts`.
 */
const ELEVATED_ROLES: readonly string[] = [SUPER_ADMIN_ROLE, 'GLOBAL_ADMIN'];

@Injectable()
export class ClsTenantContextProvider implements TenantContextProvider, OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger(ClsTenantContextProvider.name);

  constructor(private readonly cls: ClsService<IActiveUserContext>) {}

  getTenantId(): string | undefined {
    if (!this.cls.isActive()) return undefined;
    // An empty-string tenantId — super-admins authenticate without a tenant
    // binding, so their JWT/CLS carries `tenantId: ''` — means "no tenant
    // context", identical to `undefined`. Using `??` would leak the empty
    // string through, bypassing the extension's `tenantId == null` super-admin
    // pass-through and tripping `mergeTenantIntoWhere`'s mismatch guard on
    // legitimate admin cross-tenant reads (GET /admin/tenants/configs/:id).
    const resolved = this.cls.get('tenantId') ?? this.cls.get('user')?.tenantId;
    return resolved && resolved.length > 0 ? resolved : undefined;
  }

  isSuperAdmin(): boolean {
    if (!this.cls.isActive()) return true;
    return this.cls.get('user')?.roles?.some((role) => ELEVATED_ROLES.includes(role)) ?? false;
  }

  onApplicationBootstrap(): void {
    setTenantContextProvider(this);
    this.logger.log('Tenant-scope Prisma extension wired: ClsService → setTenantContextProvider');
  }

  onApplicationShutdown(): void {
    setTenantContextProvider(null);
  }
}

/**
 * Stand-alone module that owns the provider lifecycle. Imported once from
 * `AppModule.imports` — see TASK-305 §B.7. Kept separate from the Vault
 * Prisma factory so the wiring concerns stay focused.
 */
@Module({
  imports: [ClsModule],
  providers: [ClsTenantContextProvider],
  exports: [ClsTenantContextProvider],
})
export class TenantContextProviderModule {}
