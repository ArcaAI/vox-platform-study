import { ApiProperty } from '@nestjs/swagger';
import { EntityIdProperty } from '../../../decorators';
import { BaseRequest } from '../../../common';
import { IsEnum, IsJSON, IsOptional } from 'class-validator';
import { JsonValue, ResourceSubscriptionType, ResourceType } from '@arcaai/domains';

export class UpdateResourceSubscriptionRequest extends BaseRequest {
  @ApiProperty({ description: 'ID of the resource', required: false })
  @EntityIdProperty()
  @IsOptional()
  resourceId?: string;

  @ApiProperty({ description: 'Type name of the resource', required: false })
  @IsEnum(ResourceType)
  @IsOptional()
  resourceTypeName?: ResourceType;

  @ApiProperty({ description: 'Type of subscription', required: false })
  @IsEnum(ResourceSubscriptionType)
  @IsOptional()
  subscriptionType?: ResourceSubscriptionType;

  @ApiProperty({ description: 'ID of the target user', required: false })
  @EntityIdProperty()
  @IsOptional()
  targetUserId?: string;

  @ApiProperty({
    description: 'Metadata for the subscription',
    required: false,
  })
  @IsOptional()
  @IsJSON()
  subscriptionMetadata?: JsonValue;
}
