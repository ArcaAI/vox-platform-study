import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsDefined, IsIn, IsOptional, IsString } from 'class-validator';

/** The cascade scopes a write may target. Mirrors `SettingScope` in the registry. */
export const SETTING_SCOPES = ['system', 'tenant', 'department', 'doctor'] as const;

/**
 * TASK-524 — body for `PUT /admin/settings/registry/:key`.
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
}

/** Response for a successful registry write. */
export class WriteRegistrySettingResponse {
  @ApiProperty({ description: 'The registry key that was written.' })
  key!: string;

  @ApiProperty({ description: 'Storage tier the value landed in.' })
  tier!: string;

  @ApiProperty({ description: 'The value as written.' })
  value!: unknown;

  @ApiProperty({ description: 'Scope the value was set at.' })
  scope!: string;
}
