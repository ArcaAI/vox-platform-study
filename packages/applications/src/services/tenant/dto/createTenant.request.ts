import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsIn, IsArray } from 'class-validator';
import { BaseRequest } from '../../../common';
import { TenantPlan } from '@arcaai/domains';

export class CreateTenantRequest extends BaseRequest {
  @ApiProperty({ description: 'Name of the tenant' })
  @IsString()
  name!: string;

  @ApiProperty({ description: 'Unique key for the tenant' })
  @IsString()
  key!: string;

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
