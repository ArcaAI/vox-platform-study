import { Injectable, NotImplementedException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ResourceType, SysEventType, EntityId, RoleEntity, RoleFactory, RoleRepository } from '@arcaai/domains';
import { InternalServerErrorException, ArgumentInvalidException } from '@arcaai/exceptions';
import { IRoleService } from './IRoleService';
import { CreateRoleRequest, UpdateRoleRequest } from './dto';
import { BaseService, FetchResponse, PaginatedQuery, withFormattedCountProps, withFormattedPaginatedProps } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';

// TODO: Implement this

@Injectable()
export class RoleService extends BaseService implements IRoleService {
  constructor(
    private readonly roleRepository: RoleRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
  ) {
    super(eventEmitter, clsService, ResourceType.Role);
  }

  async create(request: CreateRoleRequest): Promise<RoleEntity> {
    const newRole = RoleFactory.CreateRole({
      createdBy: this.requestUser?.id,
      ...request,
    });

    const role = await this.roleRepository.create(newRole);

    if (!role) {
      throw new InternalServerErrorException(`Failed to create RoleEntity: ${request}`);
    }

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: role.id,
      createdAt: role.createdAt,
      data: role.toObject() as object,
    });
    return role;
  }

  async fetchAll(props: PaginatedQuery): Promise<FetchResponse<RoleEntity>> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { limit, page, search } = props;
    const roles = await this.roleRepository.findAll(withFormattedPaginatedProps(props));

    const count = await this.roleRepository.count(withFormattedCountProps(props));

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: {
        items: roles.map((role: RoleEntity) => role.id),
      },
    });
    return new FetchResponse<RoleEntity>({
      data: roles,
      count,
      limit,
      page,
    });
  }

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  async fetchAllByTenantId(props: PaginatedQuery & { tenantId: string }): Promise<FetchResponse<RoleEntity>> {
    throw new NotImplementedException();
  }

  async fetchAllCreatedByUser(props: PaginatedQuery & { userId: string }): Promise<FetchResponse<RoleEntity>> {
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { userId, limit, page, search } = props;
    const roles = await this.roleRepository.findAll({
      ...withFormattedPaginatedProps(props),
      where: {
        createdBy: userId,
      },
    });
    const count = await this.roleRepository.count({
      ...withFormattedCountProps(props),
      where: {
        createdBy: userId,
      },
    });

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: {
        createdBy: userId,
        items: roles.map((role: RoleEntity) => role.id),
      },
    });
    return new FetchResponse<RoleEntity>({
      data: roles,
      count,
      limit,
      page,
    });
  }

  async fetchById(id: EntityId): Promise<RoleEntity> {
    const role = await this.roleRepository.findById(id);

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      resourceId: role.id,
      data: role.toObject() as object,
    });
    return role;
  }

  async update(id: EntityId, request: UpdateRoleRequest): Promise<RoleEntity> {
    const role = await this.roleRepository.findById(id);

    const previousData = role.toObject();
    this.updateEntity(role, request);

    if (!role.hasChanges) {
      throw new ArgumentInvalidException(`No changes to write to.`);
    }
    const updatedRole = await this.roleRepository.update(id, role);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updatedRole.id,
      data: role.changes,
      previousData,
    });
    return updatedRole;
  }

  async deleteById(id: EntityId): Promise<RoleEntity> {
    const role = await this.roleRepository.softDelete(id);

    this.broadcastSysEvent(SysEventType.ResourceDeleted, {
      resourceId: role.id,
      data: role.toObject() as object,
    });
    return role;
  }
}
