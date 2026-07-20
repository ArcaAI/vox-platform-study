import { Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ResourceType, SysEventType, EntityId, RolePermissionEntity, RolePermissionFactory, RolePermissionRepository } from '@arcaai/domains';
import { InternalServerErrorException, ArgumentInvalidException } from '@arcaai/exceptions';
import { IRolePermissionService } from './IRolePermissionService';
import { CreateRolePermissionRequest, UpdateRolePermissionRequest } from './dto';
import { BaseService, FetchResponse, PaginatedQuery, withFormattedCountProps, withFormattedPaginatedProps } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';

// TODO: Implement this

@Injectable()
export class RolePermissionService extends BaseService implements IRolePermissionService {
  constructor(
    private readonly rolePermissionRepository: RolePermissionRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
  ) {
    super(eventEmitter, clsService, ResourceType.RolePermission);
  }

  async createRoleAssignment(request: CreateRolePermissionRequest): Promise<RolePermissionEntity> {
    const newRolePermission = RolePermissionFactory.CreateRolePermission({
      ...request,
      createdBy: this.requestUser?.id,
    });

    const rolePermission = await this.rolePermissionRepository.create(newRolePermission);

    if (!rolePermission) {
      throw new InternalServerErrorException(`Failed to create RolePermissionEntity: ${request}`);
    }

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: rolePermission.id,
      createdAt: rolePermission.createdAt,
      data: rolePermission.toObject() as object,
    });
    return rolePermission;
  }

  async fetchAll(props: PaginatedQuery): Promise<FetchResponse<RolePermissionEntity>> {
    const { limit, page } = props;
    const rolePermissions = await this.rolePermissionRepository.findAll(withFormattedPaginatedProps(props));

    const count = await this.rolePermissionRepository.count(withFormattedCountProps(props));

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: {
        items: rolePermissions.map((rolePermission: RolePermissionEntity) => rolePermission.id),
      },
    });
    return new FetchResponse<RolePermissionEntity>({
      data: rolePermissions,
      count,
      limit,
      page,
    });
  }

  async fetchAllByRoleId(props: PaginatedQuery & { roleId: EntityId }): Promise<FetchResponse<RolePermissionEntity>> {
    const { roleId, limit, page } = props;
    const rolePermissions = await this.rolePermissionRepository.findAll({
      ...withFormattedPaginatedProps(props),
      where: {
        roleId,
      },
    });
    const count = await this.rolePermissionRepository.count({
      ...withFormattedCountProps(props),
      where: {
        roleId,
      },
    });

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      data: {
        roleId,
        items: rolePermissions.map((rolePermission: RolePermissionEntity) => rolePermission.id),
      },
    });
    return new FetchResponse<RolePermissionEntity>({
      data: rolePermissions,
      count,
      limit,
      page,
    });
  }

  async fetchById(id: EntityId): Promise<RolePermissionEntity> {
    const rolePermission = await this.rolePermissionRepository.findById(id);

    this.broadcastSysEvent(SysEventType.ResourceViewed, {
      resourceId: rolePermission.id,
      data: rolePermission.toObject() as object,
    });
    return rolePermission;
  }

  async update(id: EntityId, request: UpdateRolePermissionRequest): Promise<RolePermissionEntity> {
    const rolePermission = await this.rolePermissionRepository.findById(id);

    const previousData = rolePermission.toObject();
    this.updateEntity(rolePermission, request);

    if (!rolePermission.hasChanges) {
      throw new ArgumentInvalidException(`No changes to write to.`);
    }
    const updatedRolePermission = await this.rolePermissionRepository.update(id, rolePermission);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: updatedRolePermission.id,
      data: rolePermission.changes,
      previousData,
    });
    return updatedRolePermission;
  }

  async deleteById(id: EntityId): Promise<RolePermissionEntity> {
    const rolePermission = await this.rolePermissionRepository.softDelete(id);

    this.broadcastSysEvent(SysEventType.ResourceDeleted, {
      resourceId: rolePermission.id,
      data: rolePermission.toObject() as object,
    });
    return rolePermission;
  }
}
