import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional } from 'class-validator';
import { BaseRequest } from '../../../../common';

export class UpdateUserRoleAssignmentRequest extends BaseRequest {
  @ApiProperty({ description: 'ID of the user', required: false })
  @IsString()
  @IsOptional()
  userId?: string;
}
