/**
 * TASK-311 AC-1 / AC-6 — `RbacRoleRepository` is the thin facade that
 * encapsulates `databaseService.client.role.*` for `RbacRoleService`.
 *
 * Surface design (README §4.3 D-2):
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
 *     Prisma calls in pre-TASK-311 code.
 *   • `create`/`update` accept the factory-built input. `update`
 *     re-issues with `ROLE_POLICIES_INCLUDE` so the returned row
 *     carries the full `RolePolicies` projection that the service
 *     hands back to its controller.
 *   • `softDelete(id, updatedBy?)` encapsulates the audit-stamp
 *     pattern (closes AC-6 per README §4.2 audit).
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
   * TASK-444 — `include` may be overridden so the role read can carry extra
   * projections (e.g. a tenant-filtered `_count.UserRoleAssignments` for
   * member counts) without duplicating the canonical policies shape.
   */
  async findByIdWithPolicies(id: string, include: unknown = ROLE_POLICIES_INCLUDE): Promise<unknown> {
    return this.delegate.findUnique({
      where: { id },
      include,
    });
  }

  async findByIdGuardSelect(id: string): Promise<{ isSystemRole: boolean; name: string } | null> {
    return this.delegate.findUnique({
      where: { id },
      select: { isSystemRole: true, name: true },
    }) as Promise<{ isSystemRole: boolean; name: string } | null>;
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

  async create(data: RbacRoleCreateInputShape): Promise<unknown> {
    return this.delegate.create({ data });
  }

  async update(id: string, data: RbacRoleUpdateInputShape): Promise<unknown> {
    return this.delegate.update({
      where: { id },
      data,
      include: ROLE_POLICIES_INCLUDE,
    });
  }

  async softDelete(id: string, updatedBy?: string): Promise<unknown> {
    return this.delegate.update({
      where: { id },
      data: {
        resourceStatus: ResourceStatusType.DELETED,
        resourceStatusUpdatedAt: new Date(),
        resourceStatusUpdatedBy: updatedBy,
      },
    });
  }
}
