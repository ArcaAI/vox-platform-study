import { Injectable, NotImplementedException } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { EventEmitter2 } from '@nestjs/event-emitter';
import {
    ResourceType,
    SysEventType,
    EntityId,
    PermissionEntity,
    PermissionFactory,
    PermissionRepository
} from '@arcaai/domains';
import {
    InternalServerErrorException,
    ArgumentInvalidException
} from '@arcaai/exceptions';
import { IPermissionService } from './IPermissionService';
import { CreatePermissionRequest, UpdatePermissionRequest } from './dto';
import {
    BaseService,
    FetchResponse,
    PaginatedQuery,
    withFormattedCountProps,
    withFormattedPaginatedProps
} from '../../../common';
import { IActiveUserContext } from '../../../interfaces';

// TODO: Implement this

@Injectable()
export class PermissionService
    extends BaseService
    implements IPermissionService
{
    constructor(
        private readonly permissionRepository: PermissionRepository,
        protected override readonly eventEmitter: EventEmitter2,
        protected override readonly clsService: ClsService<IActiveUserContext>
    ) {
        super(eventEmitter, clsService, ResourceType.Permission);
    }

    async create(request: CreatePermissionRequest): Promise<PermissionEntity> {
        const newPermission = PermissionFactory.CreatePermission({
            ...request,
            createdBy: this.requestUser?.id,
        });

        const permission = await this.permissionRepository.create(
            newPermission
        );

        if (!permission) {
            throw new InternalServerErrorException(
                `Failed to create PermissionEntity: ${request}`
            );
        }

        this.broadcastSysEvent(SysEventType.ResourceCreated, {
            resourceId: permission.id,
            createdAt: permission.createdAt,
            data: permission.toObject() as object
        });
        return permission;
    }

    async fetchAll(
        props: PaginatedQuery
    ): Promise<FetchResponse<PermissionEntity>> {
        const { limit, page, search } = props;
        const permissions = await this.permissionRepository.findAll(
            withFormattedPaginatedProps(props)
        );

        const count = await this.permissionRepository.count(
            withFormattedCountProps(props)
        );

        this.broadcastSysEvent(SysEventType.ResourceViewed, {
            data: {
                items: permissions.map(
                    (permission: PermissionEntity) => permission.id
                )
            }
        });
        return new FetchResponse<PermissionEntity>({
            data: permissions,
            count,
            limit,
            page
        });
    }

    async fetchAllByTenantId(
        props: PaginatedQuery & { tenantId: string }
    ): Promise<FetchResponse<PermissionEntity>> {
        throw new NotImplementedException();
    }

    async fetchAllCreatedByUser(
        props: PaginatedQuery & { userId: string }
    ): Promise<FetchResponse<PermissionEntity>> {
        const { userId, limit, page, search } = props;
        const permissions = await this.permissionRepository.findAll({
            ...withFormattedPaginatedProps(props),
            where: {
                createdBy: userId
            }
        });
        const count = await this.permissionRepository.count({
            ...withFormattedCountProps(props),
            where: {
                createdBy: userId
            }
        });

        this.broadcastSysEvent(SysEventType.ResourceViewed, {
            data: {
                createdBy: userId,
                items: permissions.map(
                    (permission: PermissionEntity) => permission.id
                )
            }
        });
        return new FetchResponse<PermissionEntity>({
            data: permissions,
            count,
            limit,
            page
        });
    }

    async fetchById(id: EntityId): Promise<PermissionEntity> {
        const permission = await this.permissionRepository.findById(id);

        this.broadcastSysEvent(SysEventType.ResourceViewed, {
            resourceId: permission.id,
            data: permission.toObject() as object
        });
        return permission;
    }

    async update(
        id: EntityId,
        request: UpdatePermissionRequest
    ): Promise<PermissionEntity> {
        const permission = await this.permissionRepository.findById(id);

        const previousData = permission.toObject();
        this.updateEntity(permission, request);

        if (!permission.hasChanges) {
            throw new ArgumentInvalidException(`No changes to write to.`);
        }
        const updatedPermission = await this.permissionRepository.update(
            id,
            permission
        );

        this.broadcastSysEvent(SysEventType.ResourceUpdated, {
            resourceId: updatedPermission.id,
            data: permission.changes,
            previousData
        });
        return updatedPermission;
    }

    async deleteById(id: EntityId): Promise<PermissionEntity> {
        const permission = await this.permissionRepository.softDelete(id);

        this.broadcastSysEvent(SysEventType.ResourceDeleted, {
            resourceId: permission.id,
            data: permission.toObject() as object
        });
        return permission;
    }
}
