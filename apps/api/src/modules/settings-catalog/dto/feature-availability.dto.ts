import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsBoolean, IsDefined, IsInt, IsOptional, IsString, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';

/** One resolved feature gate for the calling context. */
export class EffectiveFeatureResponse {
  @ApiProperty({ description: 'Feature-availability registry key.', example: 'console.mlflow.enabled' })
  key!: string;

  @ApiProperty({ description: 'The effective value for the resolved tenant.', example: false })
  value!: boolean;

  @ApiProperty({
    enum: ['system', 'tenant', 'default'],
    description: 'Which tier supplied it: a tenant override, the platform row, or the descriptor default.',
    example: 'system',
  })
  sourceScope!: 'system' | 'tenant' | 'default';
}

export class EffectiveFeaturesResponse {
  @ApiProperty({ type: [EffectiveFeatureResponse] })
  items!: EffectiveFeatureResponse[];
}

/** A feature row on the matrix: the descriptor fields the screen needs. */
export class FeatureMatrixFeatureResponse {
  @ApiProperty()
  key!: string;

  @ApiPropertyOptional()
  label?: string;

  @ApiPropertyOptional()
  description?: string;

  @ApiProperty({ description: 'The descriptor default — what a tenant inherits when neither it nor the platform holds a row.', example: false })
  default!: boolean;

  @ApiProperty({
    description:
      'Deepest scope a row may live at. `system` means the key has NO per-tenant row (its consumer has no tenant in hand), so the screen disables its tenant cells.',
    example: 'tenant',
  })
  maxScope!: string;

  @ApiPropertyOptional({ description: 'True = a kill-switch whose safe position is OFF.' })
  killSwitch?: boolean;

  @ApiProperty({ description: 'Server-side taxonomy bucket. Always `Feature Availability` on this route.' })
  category!: string;
}

export class FeatureMatrixTenantResponse {
  @ApiProperty()
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty({ description: 'Tenant key/slug.' })
  slug!: string;
}

export class FeatureMatrixCellResponse {
  @ApiProperty()
  key!: string;

  @ApiProperty({ description: 'A tenant id, or the literal `system` for the platform-default column.', example: 'system' })
  tenantId!: string;

  @ApiProperty({
    nullable: true,
    description: '`null` = this tenant holds no row and INHERITS the platform default. The platform column is never null.',
    example: true,
  })
  value!: boolean | null;

  @ApiProperty({ description: 'Backing row version; 0 when no row is stored. Echo it as `expectedVersion` on a write.', example: 0 })
  version!: number;
}

export class FeatureMatrixResponse {
  @ApiProperty({ type: [FeatureMatrixFeatureResponse] })
  features!: FeatureMatrixFeatureResponse[];

  @ApiProperty({
    type: [FeatureMatrixTenantResponse],
    description: 'Every non-SYSTEM tenant, Global included. SYSTEM is the platform column, not a tenant.',
  })
  tenants!: FeatureMatrixTenantResponse[];

  @ApiProperty({ type: [FeatureMatrixCellResponse] })
  cells!: FeatureMatrixCellResponse[];
}

/** One cell edit. `value: null` resets. */
export class FeatureMatrixWriteRequest {
  @ApiProperty({ description: 'Feature-availability registry key.' })
  @IsString()
  key!: string;

  @ApiProperty({ description: 'Tenant id, or the literal `system` for the platform default.' })
  @IsString()
  tenantId!: string;

  @ApiProperty({
    nullable: true,
    description:
      'The new value. `null` on a TENANT cell removes the override so it inherits again; `null` on the `system` cell rewrites the platform row to the descriptor default (the platform row is never deleted — there is nothing above it to inherit).',
  })
  // `@IsDefined()` and not an omitted `@IsOptional()`: `null` is a MEANING here
  // (reset), and the global pipe's `forbidUnknownValues` cannot tell an absent
  // property from one deliberately set to null.
  @IsDefined({ message: '`value` is required; use null to reset.' })
  @IsBoolean({ message: '`value` must be a boolean or null.' })
  @IsOptional()
  value!: boolean | null;

  @ApiPropertyOptional({ description: 'The `version` from the prior matrix read. Omit for a cell that has no stored row.', example: 3 })
  @IsOptional()
  @IsInt()
  @Min(1)
  expectedVersion?: number;
}

export class FeatureMatrixWriteBatchRequest {
  @ApiProperty({
    type: [FeatureMatrixWriteRequest],
    description: 'The cells to apply, in order. Capped at 500 — a matrix save is one screen of edits, not a migration.',
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(500)
  @ValidateNested({ each: true })
  @Type(() => FeatureMatrixWriteRequest)
  cells!: FeatureMatrixWriteRequest[];
}

export class FeatureMatrixCellErrorResponse {
  @ApiProperty()
  key!: string;

  @ApiProperty()
  tenantId!: string;

  @ApiProperty({
    description: 'The status this cell would have produced as a single-key request (412 drift, 400 refused, 403 privilege).',
    example: 412,
  })
  status!: number;

  @ApiProperty()
  message!: string;
}

export class FeatureMatrixWriteResponse {
  @ApiProperty({ type: [FeatureMatrixCellResponse], description: 'The touched cells, re-read AFTER the batch, carrying the version to echo next.' })
  cells!: FeatureMatrixCellResponse[];

  @ApiProperty({
    type: [FeatureMatrixCellErrorResponse],
    description:
      'Per-cell failures. The batch is ORDERED and PARTIAL, not all-or-nothing: one drifted cell must not discard a screenful of unrelated valid edits, and the caller re-reads and re-applies only what is listed here.',
  })
  errors!: FeatureMatrixCellErrorResponse[];
}
