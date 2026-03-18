import { ApiProperty } from '@nestjs/swagger';
import { BaseResponse, BaseResponseProps } from '../../../../common';
import { PermissionAction, JsonValue } from '@arcaai/domains';

export class PermissionResponse extends BaseResponse {
    @ApiProperty({ description: 'Name of the permission' })
    name!: string;

    @ApiProperty({
        description: 'Description of the permission',
        required: false
    })
    description?: string;

    @ApiProperty({ description: 'Permission action', enum: PermissionAction })
    permissionAction!: PermissionAction;

    @ApiProperty({ description: 'Resource type name' })
    resourceTypeName!: string;

    @ApiProperty({ description: 'Permission conditions', required: false })
    conditions?: JsonValue;

    constructor(init: PermissionResponse & BaseResponseProps) {
        super(init);
        this.name = init.name;
        this.description = init.description;
        this.permissionAction = init.permissionAction;
        this.resourceTypeName = init.resourceTypeName;
        this.conditions = init.conditions;
    }
}
