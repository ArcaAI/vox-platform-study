import { Inject, Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  CoreDatabaseService,
  DepartmentRepository,
  UserDepartmentRepository,
  UserDepartmentFactory,
  UserDepartmentEntity,
  ResourceType,
  ResourceStatusType,
  SysEventType,
} from '@arcaai/domains';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import { IUserDepartmentService } from './IUserDepartmentService';
import { AssignUserDepartmentRequest, SetUserDepartmentsRequest, UpdateUserDepartmentRequest, UserDepartmentResponse } from './dto';
import { UserDepartmentDtoMapper } from './user-department.dto.mapper';
import { BaseService, assertParentInScope, isSuperAdmin } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';

/**
 * Tenant-scoped service for user ↔ department assignments.
 *
 * `UserDepartment` is in the tenant-scope Prisma extension allow-list,
 * so reads/writes are tenant-injected automatically. Every query here
 * ALSO carries an explicit `tenantId` predicate — defence-in-depth, and required
 * to satisfy the `@@unique([tenantId, userId, departmentId])` constraint and the
 * soft-deleted-row lookup. Soft-deleted rows are reactivated on re-assign rather
 * than re-created so the unique key never collides.
 *
 * `assign()` verifies (via `assertParentInScope`) that the target `Department`
 * exists and belongs to the caller's tenant, so a membership can never
 * reference a foreign-tenant department.
 */
@Injectable()
export class UserDepartmentService extends BaseService implements IUserDepartmentService {
  constructor(
    private readonly userDepartmentRepository: UserDepartmentRepository,
    // Verify the target Department belongs to the caller's
    // tenant before binding a user to it (cross-tenant referential integrity).
    private readonly departmentRepository: DepartmentRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    // `findActiveDepartmentForUserInTenant` is a pre-auth
    // login lookup that must bypass the tenant-scope `$extends` (no CLS tenant
    // yet), mirroring `UserRoleAssignmentService`'s baseClient access.
    @Inject('CORE_DATABASE_SERVICE') private readonly databaseService: CoreDatabaseService,
  ) {
    super(eventEmitter, clsService, ResourceType.UserDepartment);
  }

  async findActiveDepartmentForUserInTenant(userId: string, tenantId: string): Promise<{ id: string } | null> {
    // BaseClient (tenant-scope bypass). The login flow calls
    // this BEFORE any tenant context exists in CLS; `UserDepartment` is in the
    // tenant-scope allow-list, so the scoped client would throw "tenant context
    // required for model UserDepartment". The tenant boundary is enforced by the
    // explicit `tenantId` predicate below, not by the `$extends`.
    const row = await this.databaseService.baseClient.userDepartment.findFirst({
      where: {
        userId,
        tenantId,
        resourceStatus: ResourceStatusType.ENABLED,
      },
      select: { id: true },
    });
    return row ?? null;
  }

  async getByUser(userId: string): Promise<UserDepartmentResponse[]> {
    // An unscoped SUPER_ADMIN (no working tenant selected) reads
    // the user's memberships CROSS-TENANT: the tenant-scope $extends bypasses
    // injection for elevated callers, so omitting the tenant predicate spans
    // all tenants. Every other caller keeps the strict tenant requirement.
    const crossTenant = !this.tenantId && isSuperAdmin(this.clsService.get('user'));
    const tenantId = crossTenant ? null : this.requireTenant();

    const assignments = await this.userDepartmentRepository.findAll({
      where: tenantId ? { tenantId, userId } : { userId },
      page: 1,
      limit: 500,
    });

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: { userId, items: assignments.map((a) => a.id) },
    });

    // The admin console renders department NAMES/CODES, not raw
    // UUIDs. Batch-resolve the distinct departmentIds in ONE query (no N+1) and
    // build an id→department map. Departments are tenant-scoped (the extended
    // client injects the tenant predicate) and the assignments above are already
    // tenant-filtered, so a foreign department can never enter this set. A
    // deleted/unresolvable department simply leaves the label fields undefined.
    const departmentById = await this.resolveDepartmentLabels(assignments.map((a) => a.departmentId));

    return assignments.map((assignment) => UserDepartmentDtoMapper.toResponse(assignment, departmentById.get(assignment.departmentId)));
  }

  /**
   * Resolve a set of (possibly duplicated) departmentIds to an
   * `id → { name, code }` map in ONE query. Returns an empty map when there are
   * no ids so callers can skip the department lookup entirely.
   */
  private async resolveDepartmentLabels(departmentIds: string[]): Promise<Map<string, { name?: string | null; code?: string | null }>> {
    const ids = Array.from(new Set(departmentIds));
    const map = new Map<string, { name?: string | null; code?: string | null }>();
    if (ids.length === 0) return map;

    const departments = await this.departmentRepository.findAll({
      where: { id: { in: ids } },
      page: 1,
      limit: ids.length,
    });
    for (const department of departments) {
      map.set(department.id, { name: department.name, code: department.code });
    }
    return map;
  }

  async assign(userId: string, dto: AssignUserDepartmentRequest): Promise<UserDepartmentResponse> {
    const tenantId = this.requireTenant();
    const { departmentId } = dto;
    const isPrimary = dto.isPrimary ?? false;

    // The department must exist AND live in the caller's
    // tenant; otherwise the membership row would reference a foreign-tenant
    // department. NotFoundException avoids leaking cross-tenant existence.
    // Reuse the already-loaded department to surface its name/code
    // on the returned row (no extra query).
    const department = await assertParentInScope(this.departmentRepository, departmentId, tenantId);

    // Reject a live duplicate before touching anything else.
    const [activeDuplicate] = await this.userDepartmentRepository.findAll({
      where: { tenantId, userId, departmentId },
      page: 1,
      limit: 1,
    });
    if (activeDuplicate) {
      throw new BadRequestException('User is already assigned to this department');
    }

    // Only one primary department per user: demote the rest first.
    if (isPrimary) {
      await this.demoteExistingPrimaries(tenantId, userId);
    }

    // A prior soft-deleted assignment still occupies the unique key, so
    // reactivate it rather than re-create (which would 23505). The explicit
    // `resourceStatus` predicate bypasses the soft-delete read filter.
    const [softDeletedDuplicate] = await this.userDepartmentRepository.findAll({
      where: { tenantId, userId, departmentId, resourceStatus: ResourceStatusType.DELETED },
      page: 1,
      limit: 1,
    });

    let saved: UserDepartmentEntity;
    if (softDeletedDuplicate) {
      const restored = await this.userDepartmentRepository.restore(softDeletedDuplicate.id, this.requestUserId ?? undefined);
      if (restored.isPrimary !== isPrimary) {
        restored.isPrimary = isPrimary;
        saved = await this.userDepartmentRepository.update(restored.id, restored);
      } else {
        saved = restored;
      }
    } else {
      const entity = UserDepartmentFactory.CreateUserDepartment({
        tenantId,
        userId,
        departmentId,
        isPrimary,
        createdBy: this.requestUserId ?? undefined,
      });
      saved = await this.userDepartmentRepository.create(entity);
    }

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: saved.id,
      createdAt: saved.createdAt,
      data: { userId, departmentId, isPrimary },
    });

    return UserDepartmentDtoMapper.toResponse(saved, { name: department.name, code: department.code });
  }

  /**
   * Reconcile a user's department memberships to EXACTLY
   * `dto.departmentIds`. Adds the missing departments (restoring a soft-deleted
   * row to respect the `@@unique([tenantId, userId, departmentId])` key),
   * soft-deletes the ones no longer wanted, and enforces the single-primary
   * invariant for `dto.primaryDepartmentId`. Every target department is verified
   * to live in the caller's tenant FIRST (404-over-403, no cross-tenant leak)
   * so a partial reconcile can never bind a foreign department.
   */
  async setDepartments(userId: string, dto: SetUserDepartmentsRequest): Promise<UserDepartmentResponse[]> {
    const tenantId = this.requireTenant();
    const targetIds = Array.from(new Set(dto.departmentIds));

    for (const departmentId of targetIds) {
      await assertParentInScope(this.departmentRepository, departmentId, tenantId);
    }

    const current = await this.userDepartmentRepository.findAll({
      where: { tenantId, userId },
      page: 1,
      limit: 500,
    });
    const currentDeptIds = new Set(current.map((a) => a.departmentId));

    // Remove memberships that are no longer wanted.
    for (const assignment of current) {
      if (targetIds.includes(assignment.departmentId)) continue;
      const deleted = await this.userDepartmentRepository.softDelete(assignment.id, this.requestUserId ?? undefined);
      this.broadcastSysEvent(SysEventType.ResourceDeleted, {
        resourceId: deleted.id,
        data: { userId, departmentId: assignment.departmentId },
      });
    }

    // Add the missing memberships (restore a soft-deleted row rather than
    // re-create, so the unique key never collides).
    for (const departmentId of targetIds) {
      if (currentDeptIds.has(departmentId)) continue;

      const [softDeletedDuplicate] = await this.userDepartmentRepository.findAll({
        where: { tenantId, userId, departmentId, resourceStatus: ResourceStatusType.DELETED },
        page: 1,
        limit: 1,
      });

      if (softDeletedDuplicate) {
        await this.userDepartmentRepository.restore(softDeletedDuplicate.id, this.requestUserId ?? undefined);
      } else {
        const entity = UserDepartmentFactory.CreateUserDepartment({
          tenantId,
          userId,
          departmentId,
          isPrimary: false,
          createdBy: this.requestUserId ?? undefined,
        });
        const created = await this.userDepartmentRepository.create(entity);
        this.broadcastSysEvent(SysEventType.ResourceCreated, {
          resourceId: created.id,
          createdAt: created.createdAt,
          data: { userId, departmentId, isPrimary: false },
        });
      }
    }

    // Enforce the single-primary invariant: clear every primary, then set the
    // requested one (ignored when it is not part of the target set).
    const primaryDepartmentId = dto.primaryDepartmentId && targetIds.includes(dto.primaryDepartmentId) ? dto.primaryDepartmentId : undefined;
    await this.demoteExistingPrimaries(tenantId, userId);
    if (primaryDepartmentId) {
      const [primaryRow] = await this.userDepartmentRepository.findAll({
        where: { tenantId, userId, departmentId: primaryDepartmentId },
        page: 1,
        limit: 1,
      });
      if (primaryRow && !primaryRow.isPrimary) {
        primaryRow.isPrimary = true;
        await this.userDepartmentRepository.update(primaryRow.id, primaryRow);
      }
    }

    // Return the resulting active set directly (no `ResourceViewed` event — this
    // is the tail of a write, not a read).
    const finalAssignments = await this.userDepartmentRepository.findAll({
      where: { tenantId, userId },
      page: 1,
      limit: 500,
    });
    // `toResponse` now takes an optional label arg, so it can no
    // longer be passed straight to `Array.map` (which would forward the index).
    return finalAssignments.map((assignment) => UserDepartmentDtoMapper.toResponse(assignment));
  }

  async update(id: string, dto: UpdateUserDepartmentRequest): Promise<UserDepartmentResponse> {
    const tenantId = this.requireTenant();

    const entity = await this.findScoped(id, tenantId);
    if (!entity) {
      throw new NotFoundException(`User department assignment ${id} not found`);
    }

    if (dto.isPrimary === true) {
      await this.demoteExistingPrimaries(tenantId, entity.userId, id);
    }
    if (dto.isPrimary !== undefined) {
      entity.isPrimary = dto.isPrimary;
    }

    // OCC precondition BEFORE the no-changes short-circuit: a stale client must
    // get 412 ("you are stale, refetch"), not 400/200, even when the payload
    // would change nothing. RFC 7232 evaluates preconditions independently of
    // the payload; the CAS below still guards concurrent writers.
    this.assertExpectedVersion(entity, dto.expectedVersion);
    if (!entity.hasChanges) {
      throw new ArgumentInvalidException('No changes to write to.');
    }

    const previousVersion = entity.version;
    const updated = await this.userDepartmentRepository.updateWithVersion(id, entity, dto.expectedVersion);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updated.id,
      data: { ...entity.changes, previousVersion, newVersion: updated.version },
    });

    return UserDepartmentDtoMapper.toResponse(updated);
  }

  async unassign(id: string): Promise<UserDepartmentResponse> {
    const tenantId = this.requireTenant();

    const entity = await this.findScoped(id, tenantId);
    if (!entity) {
      throw new NotFoundException(`User department assignment ${id} not found`);
    }

    const deleted = await this.userDepartmentRepository.softDelete(id, this.requestUserId ?? undefined);

    this.broadcastSysEvent(SysEventType.ResourceDeleted, {
      resourceId: deleted.id,
      data: { userId: entity.userId, departmentId: entity.departmentId },
    });

    return UserDepartmentDtoMapper.toResponse(deleted);
  }

  /**
   * Clear the `isPrimary` flag on every other active assignment for this user
   * so the "single primary department" invariant holds before we set a new one.
   */
  private async demoteExistingPrimaries(tenantId: string, userId: string, exceptId?: string): Promise<void> {
    const primaries = await this.userDepartmentRepository.findAll({
      where: { tenantId, userId, isPrimary: true },
      page: 1,
      limit: 100,
    });

    for (const primary of primaries) {
      if (exceptId && primary.id === exceptId) continue;
      primary.isPrimary = false;
      await this.userDepartmentRepository.update(primary.id, primary);
    }
  }

  /** Fetch an active assignment scoped to the tenant, or null if absent/foreign. */
  private async findScoped(id: string, tenantId: string): Promise<UserDepartmentEntity | null> {
    const [row] = await this.userDepartmentRepository.findAll({
      where: { id, tenantId },
      page: 1,
      limit: 1,
    });
    return row ?? null;
  }

  private requireTenant(): string {
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant ID is required');
    }
    return tenantId;
  }
}
