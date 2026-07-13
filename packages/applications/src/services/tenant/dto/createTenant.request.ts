import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsIn, IsArray, MaxLength, Validate } from 'class-validator';
import { BaseRequest } from '../../../common';
import { TenantPlan } from '@arcaai/domains';
import { NotReservedTenantKeyConstraint } from '../validators/not-reserved-tenant-key.validator';

export class CreateTenantRequest extends BaseRequest {
  @ApiProperty({ description: 'Name of the tenant' })
  @IsString()
  name!: string;

  // TASK-497 D3 — optional: auto-generated (slugified from `name`, deduped)
  // by `TenantService.create` when omitted. When supplied (global-admin
  // override), it is used as-is after validation.
  @ApiPropertyOptional({ description: 'Unique key for the tenant (auto-generated from name when omitted)' })
  @IsOptional()
  @IsString()
  @MaxLength(40)
  @Validate(NotReservedTenantKeyConstraint)
  key?: string;

  @ApiProperty({ description: 'Description of the tenant', required: false })
  @IsString()
  @IsOptional()
  description?: string;

  // TASK-387 (#3) — optional plan at creation (nullable when omitted).
  @ApiPropertyOptional({ description: 'Commercial plan', enum: TenantPlan })
  @IsOptional()
  @IsIn(Object.values(TenantPlan))
  plan?: TenantPlan;

  // TASK-387 (#2) — optional tags at creation.
  @ApiPropertyOptional({ description: 'Tenant tags', type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];
}
