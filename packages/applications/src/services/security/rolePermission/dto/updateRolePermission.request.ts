import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional } from 'class-validator';
import { BaseRequest } from '../../../../common';

export class UpdateRolePermissionRequest extends BaseRequest {
  @ApiProperty({ description: 'ID of the role', required: false })
  @IsString()
  @IsOptional()
  roleId?: string;

  @ApiProperty({ description: 'ID of the permission', required: false })
  @IsString()
  @IsOptional()
  permissionId?: string;
}
