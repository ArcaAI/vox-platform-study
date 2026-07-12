import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/**
 * TASK-496 — upsert a tenant's TTS spec. Every field is optional (null/empty =
 * inherit from the SYSTEM default); the resolver clamps to PLATFORM_TTS_LIMITS.
 * `expectedVersion` is the OCC token: `0` = create the row (none yet), `>0` =
 * compare-and-set against the current `_version` (drift → 412). The controller
 * folds the RFC 7232 `If-Match` header over this.
 */
export class UpdateTenantTtsConfigRequest {
  @ApiPropertyOptional({ description: 'Default English voice id (catalog), e.g. en-female-1' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  defaultVoiceEn?: string | null;

  @ApiPropertyOptional({ description: 'Default Malayalam voice id (catalog), e.g. ml-female-1' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  defaultVoiceMl?: string | null;

  @ApiPropertyOptional({ description: 'Ordered provider chain for en-* (clamped to allowed providers)', type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(10)
  routingEn?: string[];

  @ApiPropertyOptional({ description: 'Ordered provider chain for ml-* (clamped to allowed providers)', type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(10)
  routingMl?: string[];

  @ApiPropertyOptional({ description: 'Provider whitelist; empty = all platform providers', type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayMaxSize(10)
  allowedProviders?: string[];

  @ApiPropertyOptional({ description: 'Default output format', enum: ['pcm', 'wav', 'mp3'] })
  @IsOptional()
  @IsIn(['pcm', 'wav', 'mp3'])
  defaultFormat?: string | null;

  @ApiPropertyOptional({ description: 'Default speed (0.25–4.0)', example: 1.0 })
  @IsOptional()
  @Min(0.25)
  @Max(4.0)
  defaultSpeed?: number | null;

  @ApiPropertyOptional({ description: 'Default sample rate (Hz)', example: 24000 })
  @IsOptional()
  @IsInt()
  @IsIn([8000, 16000, 22050, 24000, 44100, 48000])
  sampleRate?: number | null;

  @ApiPropertyOptional({ description: 'Max input characters (clamped to the platform ceiling)', example: 4096 })
  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(8000)
  maxInputChars?: number | null;

  @ApiPropertyOptional({ description: 'Allow routing to the Sarvam public API (⚠️ not PHI-safe by default)' })
  @IsOptional()
  @IsBoolean()
  sarvamPublicApiAllowed?: boolean;

  @ApiProperty({
    description: 'OCC token. 0 = create (no row yet); >0 = compare-and-set against the current version (412 on drift).',
    example: 0,
  })
  @IsInt()
  @Min(0)
  expectedVersion!: number;
}
