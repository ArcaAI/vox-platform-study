import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional, IsEnum, IsObject } from 'class-validator';
import { BaseRequest } from '../../../../common';
import { PermissionAction, JsonValue } from '@arcaai/domains';

export class UpdatePermissionRequest extends BaseRequest {
    @ApiProperty({ description: 'Name of the permission', required: false })
    @IsString()
    @IsOptional()
    name?: string;

    @ApiProperty({ description: 'Description of the permission', required: false })
    @IsString()
    @IsOptional()
    description?: string;

    @ApiProperty({ description: 'Permission action', enum: PermissionAction, required: false })
    @IsEnum(PermissionAction)
    @IsOptional()
    permissionAction?: PermissionAction;

    @ApiProperty({ description: 'Resource type name', required: false })
    @IsString()
    @IsOptional()
    resourceTypeName?: string;

    @ApiProperty({ description: 'Permission conditions', required: false })
    @IsObject()
    @IsOptional()
    conditions?: JsonValue;
}
