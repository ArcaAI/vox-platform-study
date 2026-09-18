import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsIn, IsInt, Min, Validate } from 'class-validator';
import { BaseRequest } from '../../../common';
import { ResourceStatusType, TenantPlan } from '@arcaai/domains';
import { NotReservedTenantKeyConstraint } from '../validators/not-reserved-tenant-key.validator';

export class UpdateTenantRequest extends BaseRequest {
  @ApiProperty({ description: 'Name of the tenant', required: false })
  @IsString()
  @IsOptional()
  name?: string;

  // TASK-986 W1 — the same reserved-key constraint `CreateTenantRequest.key`
  // has always carried. Without it a PATCH could mint a `__GLOBAL__`-keyed
  // impostor, or rename a reserved row's key out from under the lifecycle
  // guard that used to match on it.
  @ApiProperty({ description: 'Unique key for the tenant', required: false })
  @IsString()
  @IsOptional()
  @Validate(NotReservedTenantKeyConstraint)
  key?: string;

  @ApiProperty({ description: 'Description of the tenant', required: false })
  @IsString()
  @IsOptional()
  description?: string;

  @ApiPropertyOptional({ description: 'Resource status', enum: ['ENABLED', 'DISABLED'] })
  @IsOptional()
  @IsIn([ResourceStatusType.ENABLED, ResourceStatusType.DISABLED])
  resourceStatus?: ResourceStatusType;

  // Commercial plan is editable through the OCC PATCH.
  @ApiPropertyOptional({ description: 'Commercial plan', enum: TenantPlan })
  @IsOptional()
  @IsIn(Object.values(TenantPlan))
  plan?: TenantPlan;

  // Required by the OCC contract. The
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
