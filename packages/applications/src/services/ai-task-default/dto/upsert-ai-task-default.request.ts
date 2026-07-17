import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsObject, IsOptional, IsString, MaxLength, Min } from 'class-validator';

/**
 * TASK-506 — set a tenant's default model for an AI task key. The task key
 * travels in the route; `modelSlug` must resolve to an ENABLED `AiModel` in
 * `[tenant, SYSTEM]` whose `taskType` matches the key's compatibility mapping.
 * `expectedVersion` is the OCC token: `0` = create the row (none yet), `>0` =
 * compare-and-set against the current `_version` (drift → 412). The controller
 * folds the RFC 7232 `If-Match` header over this.
 */
export class UpsertAiTaskDefaultRequest {
  @ApiProperty({
    description: 'Registry model slug to bind to the task (must resolve to an ENABLED AiModel with a compatible taskType)',
    example: 'granite-guardian-4.1-8b',
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(100)
  modelSlug!: string;

  @ApiPropertyOptional({ description: 'Task-specific extras (thresholds, etc.) persisted as JsonB', type: Object })
  @IsOptional()
  @IsObject()
  configJson?: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'OCC token. 0 = create (no row yet); >0 = compare-and-set against the current version (412 on drift).',
    example: 0,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedVersion?: number;
}
