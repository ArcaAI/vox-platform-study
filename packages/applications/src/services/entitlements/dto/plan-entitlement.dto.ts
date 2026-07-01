import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { TenantPlan } from '@arcaai/domains';

/**
 * TASK-392 (Q1) — a per-plan default-matrix row as returned to super-admins.
 * `null` in a limit field = unlimited. `version` is the OCC token; echo it as
 * `expectedVersion` on the next update.
 */
export class PlanEntitlementResponse {
  @ApiProperty({ description: 'Row ID' })
  id: string;

  @ApiProperty({ description: 'Commercial plan', enum: TenantPlan })
  plan: TenantPlan;

  @ApiPropertyOptional({ description: 'Max users/seats; null = unlimited', nullable: true })
  maxUsers?: number | null;

  @ApiPropertyOptional({ description: 'Max departments; null = unlimited', nullable: true })
  maxDepartments?: number | null;

  @ApiPropertyOptional({ description: 'Max prompt/agent templates; null = unlimited', nullable: true })
  maxPromptTemplates?: number | null;

  @ApiPropertyOptional({ description: 'Max ASR pipelines; null = unlimited', nullable: true })
  maxAsrPipelines?: number | null;

  @ApiPropertyOptional({ description: 'Max API keys; null = unlimited', nullable: true })
  maxApiKeys?: number | null;

  @ApiPropertyOptional({ description: 'Storage quota in bytes; null = unlimited', nullable: true })
  storageQuotaBytes?: number | null;

  @ApiPropertyOptional({ description: 'Max simultaneous active STT sessions (concurrency); null = unlimited', nullable: true })
  maxConcurrentSessions?: number | null;

  @ApiPropertyOptional({ description: 'Monthly consultations; null = unlimited', nullable: true })
  monthlyConsultations?: number | null;

  @ApiPropertyOptional({ description: 'Monthly transcription minutes; null = unlimited', nullable: true })
  monthlyTranscriptionMinutes?: number | null;

  @ApiPropertyOptional({ description: 'Monthly summaries; null = unlimited', nullable: true })
  monthlySummaries?: number | null;

  @ApiProperty({ description: 'DNA writing-style + reports enabled' })
  featureDnaReports: boolean;

  @ApiProperty({ description: 'Voice enrollment / diarization enabled' })
  featureVoiceEnrollment: boolean;

  @ApiProperty({ description: 'Monitoring / telemetry access enabled' })
  featureMonitoringAccess: boolean;

  @ApiProperty({ description: 'Model-access tier (base | full | full_custom)' })
  modelTier: string;

  @ApiProperty({ description: 'Rate-limit tier (strict | default | relaxed | heavy)' })
  rateLimitTier: string;

  @ApiProperty({ description: 'OCC version token' })
  version: number;
}

/**
 * TASK-392 (Q1) — super-admin edit of a per-plan default row. Every field is
 * optional; only supplied fields change. `expectedVersion` carries the OCC
 * token and is REQUIRED (the update fails with 412 on drift).
 */
export class UpdatePlanEntitlementRequest {
  @ApiPropertyOptional({ description: 'Max users/seats; null = unlimited', nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  maxUsers?: number | null;

  @ApiPropertyOptional({ description: 'Max departments; null = unlimited', nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  maxDepartments?: number | null;

  @ApiPropertyOptional({ description: 'Max prompt/agent templates; null = unlimited', nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  maxPromptTemplates?: number | null;

  @ApiPropertyOptional({ description: 'Max ASR pipelines; null = unlimited', nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  maxAsrPipelines?: number | null;

  @ApiPropertyOptional({ description: 'Max API keys; null = unlimited', nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  maxApiKeys?: number | null;

  @ApiPropertyOptional({ description: 'Storage quota in bytes; null = unlimited', nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  storageQuotaBytes?: number | null;

  @ApiPropertyOptional({ description: 'Max simultaneous active STT sessions (concurrency); null = unlimited', nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  maxConcurrentSessions?: number | null;

  @ApiPropertyOptional({ description: 'Monthly consultations; null = unlimited', nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  monthlyConsultations?: number | null;

  @ApiPropertyOptional({ description: 'Monthly transcription minutes; null = unlimited', nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  monthlyTranscriptionMinutes?: number | null;

  @ApiPropertyOptional({ description: 'Monthly summaries; null = unlimited', nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  monthlySummaries?: number | null;

  @ApiPropertyOptional({ description: 'DNA writing-style + reports enabled' })
  @IsOptional()
  @IsBoolean()
  featureDnaReports?: boolean;

  @ApiPropertyOptional({ description: 'Voice enrollment / diarization enabled' })
  @IsOptional()
  @IsBoolean()
  featureVoiceEnrollment?: boolean;

  @ApiPropertyOptional({ description: 'Monitoring / telemetry access enabled' })
  @IsOptional()
  @IsBoolean()
  featureMonitoringAccess?: boolean;

  @ApiPropertyOptional({ description: 'Model-access tier (base | full | full_custom)' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  modelTier?: string;

  @ApiPropertyOptional({ description: 'Rate-limit tier (strict | default | relaxed | heavy)' })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  rateLimitTier?: string;

  @ApiProperty({ description: 'Current row version (OCC). REQUIRED; the update fails with 412 on drift.', example: 1 })
  @IsInt()
  @Min(1)
  expectedVersion: number;
}
