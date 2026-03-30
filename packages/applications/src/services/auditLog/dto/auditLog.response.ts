import { IsBoolean, IsEnum, IsObject, IsOptional, IsString } from 'class-validator';
import { EntityIdProperty, ResourceIdProperty } from '../../../decorators';
import { BaseResponse, BaseResponseProps } from '../../../common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ResourceType, JsonValue, AuditAction } from '@arcaai/domains';

export class AuditLogResponse extends BaseResponse {
  @EntityIdProperty()
  responsibleUserId: string | null;

  @ApiProperty()
  @IsString()
  responsibleIp: string | null;

  @ApiProperty()
  @IsEnum(ResourceType)
  resourceType: ResourceType;

  @ResourceIdProperty()
  resourceId: string | null;

  @ApiProperty()
  @IsEnum(AuditAction)
  action: AuditAction;

  @ApiPropertyOptional({
    description: 'Event type categorization (e.g., AUTHORIZATION, RESOURCE, SYSTEM)',
    example: 'AUTHORIZATION',
  })
  @IsOptional()
  @IsString()
  eventType: string | null;

  @ApiPropertyOptional({
    description: 'Indicates success/failure of the operation',
    example: true,
  })
  @IsOptional()
  @IsBoolean()
  success: boolean | null;

  @ApiProperty()
  @IsObject()
  data: JsonValue | null;

  @ApiProperty()
  @IsObject()
  previousData: JsonValue | null;

  @ApiProperty()
  @IsObject()
  metadata: JsonValue | null;

  constructor(init: AuditLogResponse & BaseResponseProps) {
    super(init);
    this.responsibleUserId = init.responsibleUserId;
    this.responsibleIp = init.responsibleIp;
    this.resourceType = init.resourceType;
    this.resourceId = init.resourceId;
    this.action = init.action;
    this.eventType = init.eventType ?? null;
    this.success = init.success ?? null;
    this.data = init.data;
    this.previousData = init.previousData;
    this.metadata = init.metadata;
  }
}
