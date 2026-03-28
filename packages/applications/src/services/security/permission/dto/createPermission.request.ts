import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional, IsEnum, IsObject } from 'class-validator';
import { BaseRequest } from '../../../../common';
import { PermissionAction, JsonValue } from '@arcaai/domains';

export class CreatePermissionRequest extends BaseRequest {
  @ApiProperty({ description: 'Name of the permission' })
  name!: string;

  @ApiProperty({
    description: 'Description of the permission',
    required: false,
  })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiProperty({ description: 'Permission action', enum: PermissionAction })
  @IsEnum(PermissionAction)
  permissionAction!: PermissionAction;

  @ApiProperty({ description: 'Resource type name' })
  @IsString()
  resourceTypeName!: string;

  @ApiProperty({ description: 'Permission conditions', required: false })
  @IsObject()
  @IsOptional()
  conditions?: JsonValue;
}
