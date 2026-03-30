import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';
import { BaseRequest } from '../../../../common';

export class CreateRolePermissionRequest extends BaseRequest {
  @ApiProperty({ description: 'ID of the role' })
  @IsString()
  roleId!: string;

  @ApiProperty({ description: 'ID of the permission' })
  @IsString()
  permissionId!: string;
}
