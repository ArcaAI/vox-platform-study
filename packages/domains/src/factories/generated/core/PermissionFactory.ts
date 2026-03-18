/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { PermissionEntity, IPermissionEntity } from '../../../entities';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface CreatePermissionProps extends BaseEntityFactoryCreateProps {
    name: IPermissionEntity['name'];
    description?: IPermissionEntity['description'];
    permissionAction: IPermissionEntity['permissionAction'];
    resourceTypeName: IPermissionEntity['resourceTypeName'];
    conditions?: IPermissionEntity['conditions'];
    RolePermissions?: IPermissionEntity['RolePermissions'];

    createdAt?: IPermissionEntity['createdAt'];
    updatedAt?: IPermissionEntity['updatedAt'];
    createdBy?: IPermissionEntity['createdBy'];
    updatedBy?: IPermissionEntity['updatedBy'];
}

export class PermissionFactory {
    static CreatePermission(props: CreatePermissionProps): PermissionEntity {
        const id = generateId();
        const now = new Date();

        return new PermissionEntity({
            id,

            createdAt: props.createdAt || now,
            updatedAt: props.updatedAt || now,
            createdBy: props.createdBy ?? null,
            updatedBy: props.updatedBy || null,

            name: props.name,
            description: props.description ?? "",
            permissionAction: props.permissionAction,
            resourceTypeName: props.resourceTypeName,
            conditions: props.conditions ?? null,
            RolePermissions: props.RolePermissions ?? [],
        });
    }
}