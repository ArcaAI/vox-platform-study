import { ApiProperty } from '@nestjs/swagger';
import { IsString, IsOptional, IsBoolean, IsIn } from 'class-validator';
import { ResourceStatusType } from '@arcaai/domains';
import { BaseRequest } from '../../../../common';

export class UpdateUserRequest extends BaseRequest {
  @ApiProperty({ description: 'Username of the user', required: false })
  @IsString()
  @IsOptional()
  username?: string;

  @ApiProperty({
    description: 'Resource status (ENABLED or DISABLED)',
    enum: [ResourceStatusType.ENABLED, ResourceStatusType.DISABLED],
    required: false,
  })
  @IsIn([ResourceStatusType.ENABLED, ResourceStatusType.DISABLED])
  @IsOptional()
  resourceStatus?: ResourceStatusType;

  @ApiProperty({ description: 'Password for the user', required: false })
  @IsString()
  @IsOptional()
  password?: string;

  @ApiProperty({ description: 'External identifier', required: false })
  @IsString()
  @IsOptional()
  externalId?: string;

  @ApiProperty({
    description: 'Whether this is a service account',
    required: false,
  })
  @IsBoolean()
  @IsOptional()
  isServiceAccount?: boolean;

  // AC-05 (TASK-336) — secret1/secret2 are NOT client-assignable via the generic
  // update payload (they were mass-assignable here). Secret material is changed
  // only through the dedicated rotation flow.
}
