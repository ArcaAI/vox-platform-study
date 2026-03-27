import { ApiProperty } from '@nestjs/swagger';
import { ResourceStatusType } from '@arcaai/domains';
import { IsEnum, IsOptional } from 'class-validator';
import { EntityIdPropertyOptional } from '../../decorators';

export class BaseRequest {
  @EntityIdPropertyOptional()
  tenantId?: string;

  @ApiProperty({ required: false })
  @IsEnum(ResourceStatusType)
  @IsOptional()
  resourceStatus?: ResourceStatusType;
}
