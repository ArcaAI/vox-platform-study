import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsIn, IsInt, Min } from 'class-validator';
import { BaseRequest } from '../../../common';
import { ResourceStatusType, TenantPlan } from '@arcaai/domains';

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

  // TASK-387 (#3) — commercial plan is editable through the OCC PATCH.
  @ApiPropertyOptional({ description: 'Commercial plan', enum: TenantPlan })
  @IsOptional()
  @IsIn(Object.values(TenantPlan))
  plan?: TenantPlan;

  // TASK-302 Stream D Phase E.1.2 — required by the OCC contract. The
  // value is the row version the client was looking at (prior GET).
  // The service runs a Compare-And-Set on the database `_version`; a
  // drift between this value and the stored one yields a 412 surfaced
  // as `OptimisticConcurrencyException`.
  @ApiProperty({
    description: 'Current version of the row (from the prior GET). The PATCH fails with 412 if the version drifted.',
    example: 7,
  })
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}
