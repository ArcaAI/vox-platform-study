import { Injectable, BadRequestException, NotFoundException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
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
import { BaseService } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';

/**
 * Tenant-scoped service for user ↔ department assignments (TASK-328 A1).
 *
 * `UserDepartment` is intentionally OUTSIDE the tenant-scope Prisma extension
 * allow-list (it is not customer PHI), so every query here carries an explicit
 * `tenantId` predicate — both as a security boundary AND to satisfy the
 * `@@unique([tenantId, userId, departmentId])` constraint. Soft-deleted rows
 * are reactivated on re-assign rather than re-created so the unique key never
 * collides.
 */
@Injectable()
export class UserDepartmentService extends BaseService implements IUserDepartmentService {
  constructor(
    private readonly userDepartmentRepository: UserDepartmentRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
  ) {
    super(eventEmitter, clsService, ResourceType.UserDepartment);
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
