/**
 * `RbacRoleRepository` is the thin facade that
 * encapsulates `databaseService.client.role.*` for `RbacRoleService`.
 *
 * Surface design:
 *
 *   • `findMany(args)` / `count(args)` — pass-through to support the
 *     paged listing in `findAll` (caller owns where/skip/take/include).
 *   • `findByIdWithPolicies(id)` — the canonical "full" lookup; uses
 *     the shared `ROLE_POLICIES_INCLUDE` shape.
 *   • `findByIdGuardSelect(id)` — narrow projection of
 *     `{ isSystemRole, name }` used by the three pre-write guards
 *     (update/patch/softDelete in the service).
 *   • `findParentRoleById(id)` / `findParentRoleIdById(id)` — narrow
 *     projections backing the `validateParentRole` cycle-walk in the
 *     service. Split into two methods to mirror the two distinct
 *     Prisma calls in the legacy code.
 *   • `create`/`update` accept the factory-built input. `update`
 *     re-issues with `ROLE_POLICIES_INCLUDE` so the returned row
 *     carries the full `RolePolicies` projection that the service
 *     hands back to its controller.
 *   • `softDelete(id, updatedBy?)` encapsulates the audit-stamp
 *     pattern.
 */
import { Inject, Injectable } from '@nestjs/common';
import { CoreDatabaseService } from '../../common/databaseServices/core/core.database.service';
import { ResourceStatusType } from '../../enums';
import type { RbacRoleCreateInputShape, RbacRoleUpdateInputShape } from './RbacRoleFactory';
import { ROLE_POLICIES_INCLUDE } from './RbacRoleEntityMapper';

interface RoleDelegateLike {
  findMany: (args: unknown) => Promise<unknown[]>;
  count: (args: unknown) => Promise<number>;
  findUnique: (args: unknown) => Promise<unknown>;
  create: (args: unknown) => Promise<unknown>;
  update: (args: unknown) => Promise<unknown>;
}

@Injectable()
export class RbacRoleRepository {
  constructor(@Inject('CORE_DATABASE_SERVICE') private readonly databaseService: CoreDatabaseService) {}

  private get delegate(): RoleDelegateLike {
    return (this.databaseService.client as unknown as { role: RoleDelegateLike }).role;
  }

  async findMany(args: unknown): Promise<unknown[]> {
    return this.delegate.findMany(args);
  }

  async count(args: unknown): Promise<number> {
    return this.delegate.count(args);
  }

  /**
   * `include` may be overridden so the role read can carry extra
   * projections (e.g. a tenant-filtered `_count.UserRoleAssignments` for
   * member counts) without duplicating the canonical policies shape.
   */
  async findByIdWithPolicies(id: string, include: unknown = ROLE_POLICIES_INCLUDE): Promise<unknown> {
    return this.delegate.findUnique({
      where: { id },
      include,
    });
  }

  /**
   * TASK-766 OD-1: the projection now carries `tenantId` so the service can
   * tell "my tenant's custom role" from "a SYSTEM-owned platform role" before
   * it writes. The read itself is widened to `[caller, SYSTEM]` by the
   * tenant-scope extension (`Role` is a SYSTEM-shared read model), so ANOTHER
   * tenant's role id simply resolves to `null` here and the service turns that
   * into a 404 — the 404-over-403 posture, for free.
   */
  async findByIdGuardSelect(id: string): Promise<{ isSystemRole: boolean; name: string; tenantId: string } | null> {
    return this.delegate.findUnique({
      where: { id },
      select: { isSystemRole: true, name: true, tenantId: true },
    }) as Promise<{ isSystemRole: boolean; name: string; tenantId: string } | null>;
  }

  async findParentRoleById(id: string): Promise<{ id: string; parentRoleId: string | null } | null> {
    return this.delegate.findUnique({
      where: { id },
      select: { id: true, parentRoleId: true },
    }) as Promise<{ id: string; parentRoleId: string | null } | null>;
  }

  async findParentRoleIdById(id: string): Promise<{ parentRoleId: string | null } | null> {
    return this.delegate.findUnique({
      where: { id },
      select: { parentRoleId: true },
    }) as Promise<{ parentRoleId: string | null } | null>;
  }

  /**
   * TASK-766 OD-1 — the cross-tenant WRITE lane.
   *
   * `Role` is tenant-scoped now, so the EXTENDED client pins every write to the
   * caller's CLS tenant. That is exactly right for a tenant admin, but it
   * breaks a super admin who has a working tenant W selected and is editing a
   * SYSTEM-owned built-in: the write would carry `tenantId = W`, match zero
   * rows, and surface as P2025 instead of the edit they are entitled to make.
   *
   * `crossTenant` routes that one case through the UNSCOPED base client, so the
   * query carries only the explicit `where`. Same mechanism and same rationale
   * as `AiTaskDefaultService.crossTenantLane`; it lives HERE rather than in the
   * service because `RbacRoleService` deliberately holds no `CoreDatabaseService`
   * (all Prisma access was moved behind this repository).
   *
   * The flag is only ever set by the service AFTER an `isSuperAdmin` check, so
   * a tenant admin can never reach it.
   */
  private get unscopedDelegate(): RoleDelegateLike {
    return (this.databaseService.baseClient as unknown as { role: RoleDelegateLike }).role;
  }

  private delegateFor(crossTenant?: boolean): RoleDelegateLike {
    return crossTenant === true ? this.unscopedDelegate : this.delegate;
  }

  async create(data: RbacRoleCreateInputShape, crossTenant?: boolean): Promise<unknown> {
    return this.delegateFor(crossTenant).create({ data });
  }

  async update(id: string, data: RbacRoleUpdateInputShape, crossTenant?: boolean): Promise<unknown> {
    return this.delegateFor(crossTenant).update({
      where: { id },
      data,
      include: ROLE_POLICIES_INCLUDE,
    });
  }

  async softDelete(id: string, updatedBy?: string, crossTenant?: boolean): Promise<unknown> {
    return this.delegateFor(crossTenant).update({
      where: { id },
      data: {
        resourceStatus: ResourceStatusType.DELETED,
        resourceStatusUpdatedAt: new Date(),
        resourceStatusUpdatedBy: updatedBy,
      },
    });
  }
}
