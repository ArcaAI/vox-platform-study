import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { IsArray, IsBoolean, IsIn, IsInt, IsNumber, IsOptional, IsString, Min, ValidateNested } from 'class-validator';

/**
 * One engine's total time in the session — one `transcribe.stream` ledger row.
 *
 * TASK-874 — a session can change ASR engines mid-flight, and fallback to the
 * platform default is a METERED platform HA capability, so billing follows
 * ENGINE-TIME: the tenant's BYO minutes meter `BYOK` and the platform
 * fallback's meter `CLOUD`. `deployment` is DERIVED by `apps/stt` from the
 * credential row that actually served the span, never stamped here.
 */
export class SttStreamingUsageSegmentRequest {
  @ApiProperty({ description: 'Usage-ledger engine id that served this segment.' })
  @IsString()
  engine!: string;

  @ApiProperty({ description: 'Economic deployment kind of the engine that served this segment.', enum: ['SELF_HOSTED', 'CLOUD', 'BYOK'] })
  @IsString()
  @IsIn(['SELF_HOSTED', 'CLOUD', 'BYOK'])
  deployment!: string;

  @ApiProperty({ description: 'Decoded audio seconds on this engine.' })
  @IsNumber()
  @Min(0)
  audio_seconds!: number;

  @ApiProperty({ description: 'Wall-clock seconds on this engine.' })
  @IsNumber()
  @Min(0)
  session_seconds!: number;
}

/**
 * Body of `POST /api/v1/internal/stt/streaming/usage`.
 *
 * The STT idle reaper finalizes a session whose gateway caller crashed and
 * whose removal retries were exhausted; it builds a `transcribe.stream` teardown
 * summary that no `removeSession()` ever received and POSTs it here so the usage
 * is still metered. Snake_case mirrors the STT wire shape
 * (`StreamingSessionTeardownSummary`); the whole body is whitelisted because the
 * global pipe runs `forbidNonWhitelisted`. Recording is idempotent on the
 * session id, so a push-back racing a late DELETE teardown never double-bills.
 */
export class SttStreamingUsagePushbackRequest {
  @ApiProperty({ description: 'STT session id — the ledger idempotency identity.' })
  @IsString()
  session_id!: string;

  @ApiProperty({ description: 'Tenant the session belonged to.' })
  @IsString()
  tenant_id!: string;

  @ApiPropertyOptional({ nullable: true })
  @IsString()
  @IsOptional()
  consultation_id?: string | null;

  @ApiPropertyOptional({ nullable: true })
  @IsString()
  @IsOptional()
  user_id?: string | null;

  @ApiProperty({ description: 'Resolved pipeline id (usage attribution).' })
  @IsString()
  pipeline_id!: string;

  @ApiProperty({ description: "ISO-8601 teardown instant — the ledger event's occurredAt." })
  @IsString()
  closed_at!: string;

  @ApiProperty({ description: 'Metered audio seconds.' })
  @IsNumber()
  @Min(0)
  audio_seconds!: number;

  @ApiProperty({ description: 'Wall-clock socket open→close seconds.' })
  @IsNumber()
  @Min(0)
  session_seconds!: number;

  @ApiPropertyOptional({ nullable: true, description: 'Usage-ledger engine id; null if no ASR model loaded.' })
  @IsString()
  @IsOptional()
  engine?: string | null;

  @ApiPropertyOptional({ nullable: true, description: 'SELF_HOSTED | CLOUD | BYOK; null alongside a null engine.' })
  @IsString()
  @IsOptional()
  deployment?: string | null;

  @ApiPropertyOptional({
    type: () => [SttStreamingUsageSegmentRequest],
    description:
      'Per-engine usage breakdown (TASK-874) — one ledger row each, summing to audio_seconds/session_seconds. ' +
      'Absent from an STT that predates it, in which case the engine/deployment scalars above meter the whole session as before. ' +
      'Whitelisted because the global pipe runs forbidNonWhitelisted: without it every push-back carrying segments would 400.',
  })
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => SttStreamingUsageSegmentRequest)
  @IsOptional()
  segments?: SttStreamingUsageSegmentRequest[];

  @ApiPropertyOptional({ nullable: true })
  @IsString()
  @IsOptional()
  language_mode?: string | null;

  @ApiPropertyOptional({ description: 'Distinct mic source count (#12).', default: 1 })
  @IsInt()
  @Min(1)
  @IsOptional()
  channel_count?: number;

  @ApiProperty({ description: 'Whether the session ended on an interrupt/abort path.' })
  @IsBoolean()
  interrupted!: boolean;
}
