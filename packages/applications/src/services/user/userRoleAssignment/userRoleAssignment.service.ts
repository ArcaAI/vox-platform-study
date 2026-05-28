import { ForbiddenException, Inject, Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  CoreDatabaseService,
  ResourceType,
  ResourceStatusType,
  SysEventType,
  EntityId,
  UserRoleAssignmentEntity,
  UserRoleAssignmentFactory,
  UserRoleAssignmentRepository,
} from '@arcaai/domains';
import { InternalServerErrorException, ArgumentInvalidException, DataNotFoundException } from '@arcaai/exceptions';
import { ActiveUserRoleAssignmentRow, AuthRoleSummary, IUserRoleAssignmentService } from './IUserRoleAssignmentService';
import { CreateUserRoleAssignmentRequest, UpdateUserRoleAssignmentRequest } from './dto';
import { BaseService, FetchResponse, PaginatedQuery, withFormattedCountProps, withFormattedPaginatedProps } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';
import { SUPER_ADMIN_ROLE } from '../../tenant/constants';

// TODO: Implement this

@Injectable()
export class UserRoleAssignmentService extends BaseService implements IUserRoleAssignmentService {
  constructor(
    private readonly userRoleAssignmentRepository: UserRoleAssignmentRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    // TASK-307 W6.1 — Prisma access at the service layer is legitimate; the
    // controllers that previously did this directly (audit C-10) now route
    // through here. The two new read methods need a join (`include: Role`)
    // and a `select` projection that the generated `Repository<E,M>` base
    // class cannot express, so we fall back to the raw client at this single
    // boundary — same precedent as `TenantService.getTenantUsage`.
    @Inject('CORE_DATABASE_SERVICE') private readonly databaseService: CoreDatabaseService,
  ) {
    super(eventEmitter, clsService, ResourceType.UserRoleAssignment);
  }

  async findActiveAssignmentForUserInTenant(
    userId: string,
    tenantId: string,
  ): Promise<ActiveUserRoleAssignmentRow | null> {
    const row = await this.databaseService.client.userRoleAssignment.findFirst({
      where: {
        userId,
        tenantId,
        resourceStatus: ResourceStatusType.ENABLED,
      },
    });
    return (row as ActiveUserRoleAssignmentRow | null) ?? null;
  }

  async findActiveTenantIdsForUser(userId: string): Promise<string[]> {
    const rows = await this.databaseService.client.userRoleAssignment.findMany({
      where: {
        userId,
        resourceStatus: ResourceStatusType.ENABLED,
        tenantId: { not: null },
      },
      select: { tenantId: true },
      orderBy: { createdAt: 'asc' },
    });

    const seen = new Set<string>();
    const ordered: string[] = [];
    for (const row of rows as Array<{ tenantId: string | null }>) {
      const tenantId = row.tenantId;
      if (typeof tenantId !== 'string' || tenantId.length === 0) continue;
      if (seen.has(tenantId)) continue;
      seen.add(tenantId);
      ordered.push(tenantId);
    }
    return ordered;
  }

  async findActiveRolesForUser(userId: string): Promise<AuthRoleSummary[]> {
    const rows = await this.databaseService.client.userRoleAssignment.findMany({
      where: {
        userId,
        resourceStatus: ResourceStatusType.ENABLED,
      },
      include: { Role: true },
    });

    const result: AuthRoleSummary[] = [];
    for (const row of rows as Array<{ Role: { id: string; name: string; permissions?: string[] } | null }>) {
      const role = row.Role;
      if (!role) continue;
      result.push({
        id: role.id,
        name: role.name,
        permissions: role.permissions,
      });
    }
    return result;
  }

  async create(request: CreateUserRoleAssignmentRequest): Promise<UserRoleAssignmentEntity> {
    if (!request.userId || !request.roleId) {
      throw new ArgumentInvalidException('userId and roleId are required');
    }

    // TASK-305 D.7 (audit C-6) — pin the working tenantId to the caller's CLS
    // context. The only legitimate cross-tenant create is when the caller
    // explicitly passes `request.tenantId` AND holds the SUPER_ADMIN role
    // (used by onboarding/bootstrap flows). Otherwise an explicit mismatch
    // is a privilege-escalation attempt and must be rejected before any
    // repository or factory call runs.
    const callerTenantId = this.tenantId ?? null;
    const requestedTenantId = request.tenantId;
    const isExplicitCrossTenant = requestedTenantId !== undefined && requestedTenantId !== null && requestedTenantId !== callerTenantId;

    let effectiveTenantId: string | null;
    if (isExplicitCrossTenant) {
      if (!this.isSuperAdmin()) {
        throw new ForbiddenException('Cross-tenant assignment is not permitted');
      }
      effectiveTenantId = requestedTenantId;
    } else {
      effectiveTenantId = callerTenantId;
    }

    try {
      const existing = await this.userRoleAssignmentRepository.findFirst({
        where: {
          userId: request.userId,
          roleId: request.roleId,
          tenantId: effectiveTenantId,
          resourceStatus: ResourceStatusType.DELETED,
        },
      });
      const restored = await this.userRoleAssignmentRepository.restore(existing.id, this.requestUser?.id);
      this.broadcastSysEvent(SysEventType.ResourceCreated, {
        resourceId: restored.id,
        createdAt: restored.createdAt,
        data: restored.toObject() as object,
      });
      return restored;
    } catch (e) {
      if (!(e instanceof DataNotFoundException)) throw e;
    }

    const newUserRoleAssignment = UserRoleAssignmentFactory.CreateUserRoleAssignment({
      ...request,
      tenantId: effectiveTenantId,
      userId: request.userId,
      roleId: request.roleId,
      createdBy: this.requestUser?.id,
    });

    const userRoleAssignment = await this.userRoleAssignmentRepository.create(newUserRoleAssignment);

    if (!userRoleAssignment) {
      throw new InternalServerErrorException(`Failed to create UserRoleAssignmentEntity: ${request}`);
    }

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: userRoleAssignment.id,
      createdAt: userRoleAssignment.createdAt,
      data: userRoleAssignment.toObject() as object,
    });
    return userRoleAssignment;
  }

  /**
   * True when the active request user carries the `SUPER_ADMIN` role.
   * Mirrors the pattern in `TenantService.isSuperAdmin()` — falls back to
   * `false` whenever the CLS context is missing or the role list is
   * undefined, so the strictest behaviour applies by default.
   */
  private isSuperAdmin(): boolean {
    const roles = this.requestUser?.roles;
    return Array.isArray(roles) && roles.includes(SUPER_ADMIN_ROLE);
  }

  async fetchAll(props: PaginatedQuery): Promise<FetchResponse<UserRoleAssignmentEntity>> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { limit, page, search } = props;
    const userRoleAssignments = await this.userRoleAssignmentRepository.findAll(withFormattedPaginatedProps(props));

    const count = await this.userRoleAssignmentRepository.count(withFormattedCountProps(props));

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: {
        items: userRoleAssignments.map((userRoleAssignment: UserRoleAssignmentEntity) => userRoleAssignment.id),
      },
    });
    return new FetchResponse<UserRoleAssignmentEntity>({
      data: userRoleAssignments,
      count,
      limit,
      page,
    });
  }

  async fetchAllByTenantId(props: PaginatedQuery & { tenantId: string }): Promise<FetchResponse<UserRoleAssignmentEntity>> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { tenantId, limit, page, search } = props;
    const userRoleAssignments = await this.userRoleAssignmentRepository.findAll({
      ...withFormattedPaginatedProps(props),
      where: {
        tenantId,
      },
    });
    const count = await this.userRoleAssignmentRepository.count({
      ...withFormattedCountProps(props),
      where: {
        tenantId,
      },
    });

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: {
        tenantId,
        items: userRoleAssignments.map((userRoleAssignment: UserRoleAssignmentEntity) => userRoleAssignment.id),
      },
    });
    return new FetchResponse<UserRoleAssignmentEntity>({
      data: userRoleAssignments,
      count,
      limit,
      page,
    });
  }

  async fetchAllCreatedByUser(props: PaginatedQuery & { userId: string }): Promise<FetchResponse<UserRoleAssignmentEntity>> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { userId, limit, page, search } = props;
    const userRoleAssignments = await this.userRoleAssignmentRepository.findAll({
      ...withFormattedPaginatedProps(props),
      where: {
        createdBy: userId,
      },
    });
    const count = await this.userRoleAssignmentRepository.count({
      ...withFormattedCountProps(props),
      where: {
        createdBy: userId,
      },
    });

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: {
        createdBy: userId,
        items: userRoleAssignments.map((userRoleAssignment: UserRoleAssignmentEntity) => userRoleAssignment.id),
      },
    });
    return new FetchResponse<UserRoleAssignmentEntity>({
      data: userRoleAssignments,
      count,
      limit,
      page,
    });
  }

  async fetchAllByUserId(props: PaginatedQuery & { userId: string }): Promise<FetchResponse<UserRoleAssignmentEntity>> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { userId, limit, page, search } = props;
    const userRoleAssignments = await this.userRoleAssignmentRepository.findAll({
      ...withFormattedPaginatedProps(props),
      where: {
        userId,
      },
    });
    const count = await this.userRoleAssignmentRepository.count({
      ...withFormattedCountProps(props),
      where: {
        userId,
      },
    });

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: {
        userId,
        items: userRoleAssignments.map((userRoleAssignment: UserRoleAssignmentEntity) => userRoleAssignment.id),
      },
    });
    return new FetchResponse<UserRoleAssignmentEntity>({
      data: userRoleAssignments,
      count,
      limit,
      page,
    });
  }

  async fetchById(id: EntityId): Promise<UserRoleAssignmentEntity> {
    const userRoleAssignment = await this.userRoleAssignmentRepository.findById(id);

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      resourceId: userRoleAssignment.id,
      data: userRoleAssignment.toObject() as object,
    });
    return userRoleAssignment;
  }

  async update(id: EntityId, request: UpdateUserRoleAssignmentRequest): Promise<UserRoleAssignmentEntity> {
    const userRoleAssignment = await this.userRoleAssignmentRepository.findById(id);

    const previousData = userRoleAssignment.toObject();
    this.updateEntity(userRoleAssignment, request);

    if (!userRoleAssignment.hasChanges) {
      throw new ArgumentInvalidException(`No changes to write to.`);
    }
    const updatedUserRoleAssignment = await this.userRoleAssignmentRepository.update(id, userRoleAssignment);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updatedUserRoleAssignment.id,
      data: userRoleAssignment.changes,
      previousData,
    });
    return updatedUserRoleAssignment;
  }

  async deleteById(id: EntityId): Promise<UserRoleAssignmentEntity> {
    const userRoleAssignment = await this.userRoleAssignmentRepository.softDelete(id);

    this.broadcastSysEvent(SysEventType.ResourceDeleted, {
      resourceId: userRoleAssignment.id,
      data: userRoleAssignment.toObject() as object,
    });
    return userRoleAssignment;
  }
}
