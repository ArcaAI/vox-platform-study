import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsIn } from 'class-validator';
import { BaseRequest } from '../../../common';
import { ResourceStatusType } from '@arcaai/domains';

export class UpdateTenantRequest extends BaseRequest {
  @ApiProperty({ description: 'Name of the tenant', required: false })
  @IsString()
  @IsOptional()
  name?: string;

  @ApiProperty({ description: 'Unique key for the tenant', required: false })
  @IsString()
  @IsOptional()
  key?: string;

  @ApiProperty({ description: 'Description of the tenant', required: false })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({ description: 'Resource status', enum: ['ENABLED', 'DISABLED'] })
  @IsOptional()
  @IsIn([ResourceStatusType.ENABLED, ResourceStatusType.DISABLED])
  resourceStatus?: ResourceStatusType;
}
