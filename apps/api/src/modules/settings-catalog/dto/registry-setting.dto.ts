import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDefined, IsIn, IsInt, IsOptional, IsString, Min } from 'class-validator';

/** The cascade scopes a write may target. Mirrors `SettingScope` in the registry. */
export const SETTING_SCOPES = ['system', 'tenant', 'department', 'doctor'] as const;

/**
 * Body for `PUT /admin/settings/registry/:key`.
 *
 * `value` is intentionally untyped here: its shape is governed by the
 * descriptor's declared `dataType` and validated server-side by
 * `SettingsRegistryWriteService`. Declaring it as a typed field would force one
 * DTO per data type; the registry is the single enforcement point instead.
 *
 * NOTE `@IsDefined()` (not merely `@IsOptional()` omitted): the global pipe
 * runs `forbidUnknownValues`, but a missing property with no decorator that
 * asserts presence would silently pass as `undefined`.
 */
export class WriteRegistrySettingRequest {
  @ApiProperty({
    description: 'The new value. Its type must match the descriptor `dataType` (boolean / number / string / enum / string[] / json).',
    example: 9000,
  })
  @IsDefined({ message: '`value` is required.' })
  value!: unknown;

  @ApiPropertyOptional({
    description: 'Scope to set the value at. Defaults to `system`. Rejected when deeper than the descriptor maxScope.',
    enum: SETTING_SCOPES,
    default: 'system',
  })
  @IsOptional()
  @IsString()
  @IsIn(SETTING_SCOPES)
  scope?: (typeof SETTING_SCOPES)[number];

  /**
   * Optimistic-concurrency token: the `version` from the prior GET.
   * The canonical form carries it in the `If-Match` header (which wins over this
   * field); service-to-service callers may pass it here. REQUIRED when a stored
   * value already exists — omitting it is refused 428 rather than silently
   * overwriting a concurrent edit. Omit on a first write.
   */
  @ApiPropertyOptional({ description: 'Version from the prior GET. Required once a value is stored; PUT fails 412 if it drifted.', example: 3 })
  @IsOptional()
  @IsInt()
  @Min(1)
  expectedVersion?: number;
}

/** Response for a successful registry write. */
export class WriteRegistrySettingResponse {
  /**
   * The row version after this write. The `ETagInterceptor` renders
   * it as `ETag: "<version>"`, so a client can chain edits without re-reading.
   */
  @ApiProperty({ description: 'Row version after the write. Echo as the next `If-Match`.', example: 4 })
  version!: number;

  @ApiProperty({ description: 'The registry key that was written.' })
  key!: string;

  @ApiProperty({ description: 'Storage tier the value landed in.' })
  tier!: string;

  @ApiProperty({ description: 'The value as written.' })
  value!: unknown;

  @ApiProperty({ description: 'Scope the value was set at.' })
  scope!: string;
}

/** Response for a successful registry RESET (a tenant override removed). */
export class ResetRegistrySettingResponse {
  @ApiProperty({ description: 'The registry key whose tenant override was reset.' })
  key!: string;

  @ApiProperty({ description: 'Storage tier the row lived in.' })
  tier!: string;

  @ApiProperty({ description: 'Scope that was reset. Always `tenant` today.' })
  scope!: string;

  @ApiProperty({
    description:
      'False when there was no override to remove. Idempotent by design: a "reset every tenant" sweep must not fail on the tenants that never had one.',
    example: true,
  })
  removed!: boolean;
}
