import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsNumber, IsOptional, IsString, Min } from 'class-validator';

/**
 * Body of `POST /api/v1/internal/stt/streaming/usage` (TASK-615 #13).
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

  @ApiPropertyOptional({ nullable: true })
  @IsString()
  @IsOptional()
  language_mode?: string | null;

  @ApiPropertyOptional({ description: 'Distinct mic source count (TASK-615 #12).', default: 1 })
  @IsInt()
  @Min(1)
  @IsOptional()
  channel_count?: number;

  @ApiProperty({ description: 'Whether the session ended on an interrupt/abort path.' })
  @IsBoolean()
  interrupted!: boolean;
}
