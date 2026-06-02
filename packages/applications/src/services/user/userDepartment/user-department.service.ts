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
import { AssignUserDepartmentRequest, UpdateUserDepartmentRequest, UserDepartmentResponse } from './dto';
import { UserDepartmentDtoMapper } from './user-department.dto.mapper';
import { BaseService, assertParentInScope } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';

/**
 * Tenant-scoped service for user ↔ department assignments (TASK-328 A1;
 * membership enforcement TASK-305 Phase F).
 *
 * `UserDepartment` is in the tenant-scope Prisma extension allow-list (added by
 * Phase F), so reads/writes are tenant-injected automatically. Every query here
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
    // TASK-305 Phase F — verify the target Department belongs to the caller's
    // tenant before binding a user to it (cross-tenant referential integrity).
    private readonly departmentRepository: DepartmentRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    // TASK-305 Phase F — `findActiveDepartmentForUserInTenant` is a pre-auth
    // login lookup that must bypass the tenant-scope `$extends` (no CLS tenant
    // yet), mirroring `UserRoleAssignmentService`'s baseClient access.
    @Inject('CORE_DATABASE_SERVICE') private readonly databaseService: CoreDatabaseService,
  ) {
    super(eventEmitter, clsService, ResourceType.UserDepartment);
  }

  async findActiveDepartmentForUserInTenant(userId: string, tenantId: string): Promise<{ id: string } | null> {
    // TASK-305 Phase F — baseClient (tenant-scope bypass). The login flow calls
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
    const tenantId = this.requireTenant();

    const assignments = await this.userDepartmentRepository.findAll({
      where: { tenantId, userId },
      page: 1,
      limit: 500,
    });

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: { userId, items: assignments.map((a) => a.id) },
    });

    return assignments.map(UserDepartmentDtoMapper.toResponse);
  }

  async assign(userId: string, dto: AssignUserDepartmentRequest): Promise<UserDepartmentResponse> {
    const tenantId = this.requireTenant();
    const { departmentId } = dto;
    const isPrimary = dto.isPrimary ?? false;

    // TASK-305 Phase F — the department must exist AND live in the caller's
    // tenant; otherwise the membership row would reference a foreign-tenant
    // department. NotFoundException avoids leaking cross-tenant existence.
    await assertParentInScope(this.departmentRepository, departmentId, tenantId);

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

    return UserDepartmentDtoMapper.toResponse(saved);
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
