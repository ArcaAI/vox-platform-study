import { IsBoolean, IsEnum, IsObject, IsOptional, IsString, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { EntityIdProperty, ResourceIdProperty } from '../../../decorators';
import { BaseResponse, BaseResponseProps } from '../../../common';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ResourceType, JsonValue, AuditAction } from '@arcaai/domains';

/**
 * TASK-328 A8 — the acting (responsible) user resolved for an audit row.
 *
 * `responsibleUserId` is only a foreign key; the admin table needs a
 * human-readable label. The service resolves the id to this shape (display
 * name from the user profile, falling back to username) so the UI never has
 * to issue an N+1 lookup per row.
 */
export class ResponsibleUserResponse {
  @ApiProperty({ description: 'The acting user id.' })
  @IsString()
  id: string;

  @ApiPropertyOptional({ description: 'Display name (profile name, else username).' })
  @IsOptional()
  @IsString()
  displayName: string | null;

  @ApiPropertyOptional({ description: 'Email address, when available.' })
  @IsOptional()
  @IsString()
  email: string | null;

  constructor(init: ResponsibleUserResponse) {
    this.id = init.id;
    this.displayName = init.displayName ?? null;
    this.email = init.email ?? null;
  }
}

export class AuditLogResponse extends BaseResponse {
  /**
   * TASK-331 doc-03 F6 — owning tenant id. The column is NOT NULL on the entity
   * (TASK-305 Phase A); the global-scope admin console resolves it to a tenant
   * name and renders a Tenant column. It is declared here because
   * `AutoEntityMapper` only copies fields present on the target DTO — without
   * this property the id is silently dropped and never reaches the wire.
   */
  @EntityIdProperty()
  tenantId: string;

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

  @ApiPropertyOptional({
    type: ResponsibleUserResponse,
    description: 'TASK-328 A8 — the acting user resolved from responsibleUserId.',
  })
  @IsOptional()
  @ValidateNested()
  @Type(() => ResponsibleUserResponse)
  responsibleUser: ResponsibleUserResponse | null;

  constructor(init: AuditLogResponse & BaseResponseProps) {
    super(init);
    this.tenantId = init.tenantId;
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
    this.responsibleUser = init.responsibleUser ?? null;
  }
}
