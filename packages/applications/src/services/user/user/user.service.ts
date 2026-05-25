import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ResourceType, ResourceStatusType, SysEventType, EntityId, UserEntity, UserFactory, UserRepository } from '@arcaai/domains';
import { InternalServerErrorException, ArgumentInvalidException, NotFoundException } from '@arcaai/exceptions';
import { IUserService } from './IUserService';
import { CreateOAuthUserRequest, CreateUserRequest, UpdateUserRequest } from './dto';
import { BaseService, FetchResponse, PaginatedQuery, withFormattedPaginatedProps, withFormattedCountProps } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';

// TODO: Implement this

@Injectable()
export class UserService extends BaseService implements IUserService {
  constructor(
    private readonly userRepository: UserRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
  ) {
    super(eventEmitter, clsService, ResourceType.User);
  }

  async create(request: CreateUserRequest): Promise<UserEntity> {
    const newUser = UserFactory.CreateUser({
      ...request,
      externalId: request.externalId || null,
      isServiceAccount: request.isServiceAccount ?? false,
      createdBy: this.requestUser?.id,
    });

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
    const users = await this.userRepository.findAll(withFormattedPaginatedProps(props));

    const count = await this.userRepository.count(withFormattedCountProps(props));

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
      ...withFormattedPaginatedProps(props),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      where: tenantWhere as any,
    });
    const count = await this.userRepository.count({
      ...withFormattedCountProps(props),
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
      ...withFormattedPaginatedProps(props),
      where: {
        createdBy: userId,
      },
    });
    const count = await this.userRepository.count({
      ...withFormattedCountProps(props),
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
