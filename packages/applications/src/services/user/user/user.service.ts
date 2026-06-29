import { Injectable, Inject, BadRequestException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
  ResourceType,
  ResourceStatusType,
  SysEventType,
  EntityId,
  UserEntity,
  UserFactory,
  UserRepository,
  UserRoleAssignmentEntity,
  UserRoleAssignmentFactory,
  UserRoleAssignmentRepository,
  UserDepartmentEntity,
  UserDepartmentFactory,
  UserDepartmentRepository,
  CoreDatabaseService,
} from '@arcaai/domains';
import { InternalServerErrorException, ArgumentInvalidException, NotFoundException } from '@arcaai/exceptions';
import { IUserService } from './IUserService';
import { CreateOAuthUserRequest, CreateUserRequest, UpdateUserRequest } from './dto';
import { BaseService, FetchResponse, PaginatedQuery, withFormattedPaginatedProps, withFormattedCountProps } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';

/**
 * TASK-375 §8 — the Users resource's Prisma model name. Passed to
 * `withFormatted{Paginated,Count}Props` so the shared deserializer coerces
 * EVERY boolean/number/date column of `User` from its stringly-typed CSV
 * `filters` value to the column's real type before the `where` reaches Prisma
 * (e.g. `isServiceAccount` → boolean, `version` → number, `createdAt` /
 * `lastLoginAt` → Date). Supersedes the per-column boolean opt-in
 * (DEFECT-F1's `['isServiceAccount']` allow-list); String/enum columns stay strings.
 * Passed to BOTH the data and count builders so they stay in lock-step.
 */
const USER_FILTER_MODEL = 'User';

// TODO: Implement this

@Injectable()
export class UserService extends BaseService implements IUserService {
  constructor(
    private readonly userRepository: UserRepository,
    private readonly userRoleAssignmentRepository: UserRoleAssignmentRepository,
    private readonly userDepartmentRepository: UserDepartmentRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    // TASK-331 r2605 #3 — `baseClient.$transaction(callback)` is the canonical
    // Prisma-7 atomic idiom in this codebase (see TenantService TASK-302 D.4).
    @Inject('CORE_DATABASE_SERVICE') private readonly databaseService: CoreDatabaseService,
  ) {
    super(eventEmitter, clsService, ResourceType.User);
  }

  async create(request: CreateUserRequest): Promise<UserEntity> {
    const { roleId, departmentId, isPrimaryDepartment, ...userRequest } = request;
    const wantsMembership = Boolean(roleId || departmentId);

    const newUser = UserFactory.CreateUser({
      ...userRequest,
      externalId: userRequest.externalId || null,
      isServiceAccount: userRequest.isServiceAccount ?? false,
      createdBy: this.requestUser?.id,
    });

    if (!wantsMembership) {
      const user = await this.userRepository.create(newUser);

      if (!user) {
        throw new InternalServerErrorException(`Failed to create UserEntity: ${request}`);
      }

      this.broadcastSysEvent(SysEventType.ResourceCreated, {
        resourceId: user.id,
        createdAt: user.createdAt,
        data: user.toObject() as object,
      });
      return user;
    }

    // TASK-331 r2605 #3 — membership requested. Tenant attribution comes from
    // the ACTIVE CLS tenant (a super-admin's selected tenant is elevated into
    // CLS by the context interceptor; a tenant-admin's comes from their
    // session). It is NEVER taken from the request body — the same security
    // boundary `broadcastSysEvent` enforces for `tenantId`.
    const tenantId = this.tenantId;
    if (!tenantId) {
      throw new BadRequestException('Tenant context required to assign role/department');
    }

    // Create the identity + membership rows atomically so a partial failure
    // leaves NO orphaned user (which would silently fail the Phase F login
    // invariant). Each repository.create participates via the supplied `tx`.
    const { user, roleAssignment, departmentAssignment } = await this.databaseService.baseClient.$transaction(async (tx) => {
      const createdUser = await this.userRepository.create(newUser, tx);
      if (!createdUser) {
        throw new InternalServerErrorException(`Failed to create UserEntity: ${request}`);
      }

      let roleAssignment: UserRoleAssignmentEntity | undefined;
      if (roleId) {
        const roleEntity = UserRoleAssignmentFactory.CreateUserRoleAssignment({
          userId: createdUser.id,
          roleId,
          tenantId,
          createdBy: this.requestUser?.id,
        });
        roleAssignment = await this.userRoleAssignmentRepository.create(roleEntity, tx);
      }

      let departmentAssignment: UserDepartmentEntity | undefined;
      if (departmentId) {
        const departmentEntity = UserDepartmentFactory.CreateUserDepartment({
          tenantId,
          userId: createdUser.id,
          departmentId,
          isPrimary: isPrimaryDepartment ?? false,
          createdBy: this.requestUser?.id,
        });
        departmentAssignment = await this.userDepartmentRepository.create(departmentEntity, tx);
      }

      return { user: createdUser, roleAssignment, departmentAssignment };
    });

    // Broadcast AFTER commit so a rolled-back transaction emits no audit noise.
    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: user.id,
      createdAt: user.createdAt,
      data: user.toObject() as object,
    });
    if (roleAssignment) {
      this.broadcastSysEvent(SysEventType.ResourceCreated, {
        resourceType: ResourceType.UserRoleAssignment,
        resourceId: roleAssignment.id,
        createdAt: roleAssignment.createdAt,
        data: roleAssignment.toObject() as object,
      });
    }
    if (departmentAssignment) {
      this.broadcastSysEvent(SysEventType.ResourceCreated, {
        resourceType: ResourceType.UserDepartment,
        resourceId: departmentAssignment.id,
        createdAt: departmentAssignment.createdAt,
        data: departmentAssignment.toObject() as object,
      });
    }
    return user;
  }

  async createExternalUser(request: CreateOAuthUserRequest): Promise<UserEntity> {
    const newUser = UserFactory.CreateUser({
      ...request,
      username: request.externalId,
      password: '',
      isServiceAccount: false,
      createdBy: this.requestUser?.id,
    });

    const user = await this.userRepository.create(newUser);

    if (!user) {
      throw new InternalServerErrorException(`Failed to create external UserEntity: ${request}`);
    }

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: user.id,
      createdAt: user.createdAt,
      data: user.toObject() as object,
    });
    return user;
  }

  async fetchAll(props: PaginatedQuery): Promise<FetchResponse<UserEntity>> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { limit, page, search } = props;
    const users = await this.userRepository.findAll(withFormattedPaginatedProps(props, USER_FILTER_MODEL));

    const count = await this.userRepository.count(withFormattedCountProps(props, USER_FILTER_MODEL));

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: {
        items: users.map((user: UserEntity) => user.id),
      },
    });
    return new FetchResponse<UserEntity>({
      data: users,
      count,
      limit,
      page,
    });
  }

  async fetchAllByTenantId(props: PaginatedQuery & { tenantId: string }): Promise<FetchResponse<UserEntity>> {
    const { tenantId, limit, page } = props;
    // Prisma relational filter — DbFilters doesn't model `some`. The
    // `resourceStatus: { not: DELETED }` clause excludes users whose only
    // membership in this tenant is via a soft-deleted UserRoleAssignment.
    const tenantWhere = {
      UserRoleAssignments: { some: { tenantId, resourceStatus: { not: ResourceStatusType.DELETED } } },
    } as Record<string, unknown>;

    const users = await this.userRepository.findAll({
      ...withFormattedPaginatedProps(props, USER_FILTER_MODEL),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      where: tenantWhere as any,
    });
    const count = await this.userRepository.count({
      ...withFormattedCountProps(props, USER_FILTER_MODEL),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      where: tenantWhere as any,
    });

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: {
        tenantId,
        items: users.map((user: UserEntity) => user.id),
      },
    });
    return new FetchResponse<UserEntity>({
      data: users,
      count,
      limit,
      page,
    });
  }

  async fetchAllCreatedByUser(props: PaginatedQuery & { userId: string }): Promise<FetchResponse<UserEntity>> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { userId, limit, page, search } = props;
    const users = await this.userRepository.findAll({
      ...withFormattedPaginatedProps(props, USER_FILTER_MODEL),
      where: {
        createdBy: userId,
      },
    });
    const count = await this.userRepository.count({
      ...withFormattedCountProps(props, USER_FILTER_MODEL),
      where: {
        createdBy: userId,
      },
    });

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: {
        createdBy: userId,
        items: users.map((user: UserEntity) => user.id),
      },
    });
    return new FetchResponse<UserEntity>({
      data: users,
      count,
      limit,
      page,
    });
  }

  async fetchById(id: EntityId): Promise<UserEntity> {
    const user = await this.userRepository.findById(id);

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      resourceId: user.id,
      data: user.toObject() as object,
    });
    return user;
  }

  async fetchByExternalId(externalId: string): Promise<UserEntity> {
    const user = await this.userRepository.findFirst({
      where: { externalId },
    });

    if (!user) {
      throw new NotFoundException(`User with external ID ${externalId} not found.`);
    }

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      resourceId: user.id,
      data: user.toObject() as object,
    });
    return user;
  }

  async update(id: EntityId, request: UpdateUserRequest): Promise<UserEntity> {
    const user = await this.userRepository.findById(id);

    const previousData = user.toObject();
    this.updateEntity(user, request);

    if (!user.hasChanges) {
      throw new ArgumentInvalidException(`No changes to write to.`);
    }
    const updatedUser = await this.userRepository.update(id, user);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updatedUser.id,
      data: user.changes,
      previousData,
    });
    return updatedUser;
  }

  async deleteById(id: EntityId): Promise<UserEntity> {
    const user = await this.userRepository.softDelete(id);

    this.broadcastSysEvent(SysEventType.ResourceDeleted, {
      resourceId: user.id,
      data: user.toObject() as object,
    });
    return user;
  }
}
