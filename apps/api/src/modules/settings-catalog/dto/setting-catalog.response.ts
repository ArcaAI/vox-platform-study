import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * TASK-504 Phase 3c — one entry in the capability/settings catalog. Pure
 * metadata about a controllable setting (never a value); safe to expose.
 */
export class SettingCatalogItemResponse {
  @ApiProperty({ description: 'Canonical dotted key, e.g. pipeline.autoSummaryEnabled.' })
  key!: string;

  @ApiProperty({ description: 'Storage tier / §3 data class.', example: 'db-config' })
  tier!: string;

  @ApiProperty({ example: 'boolean' })
  dataType!: string;

  @ApiProperty({ enum: ['public', 'internal', 'secret'], example: 'internal' })
  sensitivity!: string;

  @ApiProperty({ description: 'Deepest scope a tenant admin may set this at.', example: 'tenant' })
  maxScope!: string;

  @ApiProperty({ description: 'CASL subject that gates who may edit it.', example: 'PipelinePolicy' })
  editableBy!: string;

  @ApiProperty({ description: 'Server-side taxonomy bucket.', example: 'Pipeline' })
  category!: string;

  @ApiPropertyOptional({ description: 'True = GLOBAL_ADMIN-only surface.' })
  globalOnly?: boolean;

  @ApiPropertyOptional()
  label?: string;

  @ApiPropertyOptional()
  description?: string;
}

export class SettingCatalogResponse {
  @ApiProperty({ type: [SettingCatalogItemResponse] })
  items!: SettingCatalogItemResponse[];

  @ApiProperty({ type: [String], description: 'Distinct categories present in items, sorted.' })
  categories!: string[];
}

/**
 * TASK-504 — resolved effective value of one non-secret setting for a context,
 * with the winning cascade tier. Secret settings are refused (never resolved).
 */
export class EffectiveSettingResponse {
  @ApiProperty()
  key!: string;

  @ApiProperty({ example: 'db-config' })
  tier!: string;

  @ApiProperty({ description: 'The resolved effective value (type depends on the setting).' })
  value!: unknown;

  @ApiProperty({ description: 'Which cascade tier supplied the value.', example: 'department' })
  sourceScope!: string;
}
