import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

/**
 * TASK-392 (Q1/Q7) — a per-tenant entitlement override as returned to admins.
 * Every field is nullable: `null` = "inherit the plan default". `version` is
 * the OCC token.
 */
export class TenantEntitlementResponse {
  @ApiProperty({ description: 'Row ID' })
  id: string;

  @ApiProperty({ description: 'Tenant ID' })
  tenantId: string;

  @ApiPropertyOptional({ description: 'Override max users; null = inherit', nullable: true })
  maxUsers?: number | null;

  @ApiPropertyOptional({ description: 'Override max departments; null = inherit', nullable: true })
  maxDepartments?: number | null;

  @ApiPropertyOptional({ description: 'Override max prompt templates; null = inherit', nullable: true })
  maxPromptTemplates?: number | null;

  @ApiPropertyOptional({ description: 'Override max ASR pipelines; null = inherit', nullable: true })
  maxAsrPipelines?: number | null;

  @ApiPropertyOptional({ description: 'Override max API keys; null = inherit', nullable: true })
  maxApiKeys?: number | null;

  @ApiPropertyOptional({ description: 'Override storage quota bytes; null = inherit', nullable: true })
  storageQuotaBytes?: number | null;

  @ApiPropertyOptional({ description: 'Override max concurrent STT sessions; null = inherit', nullable: true })
  maxConcurrentSessions?: number | null;

  @ApiPropertyOptional({ description: 'Override monthly consultations; null = inherit', nullable: true })
  monthlyConsultations?: number | null;

  @ApiPropertyOptional({ description: 'Override monthly transcription minutes; null = inherit', nullable: true })
  monthlyTranscriptionMinutes?: number | null;

  @ApiPropertyOptional({ description: 'Override monthly summaries; null = inherit', nullable: true })
  monthlySummaries?: number | null;

  @ApiPropertyOptional({ description: 'Override DNA reports feature; null = inherit', nullable: true })
  featureDnaReports?: boolean | null;

  @ApiPropertyOptional({ description: 'Override voice enrollment feature; null = inherit', nullable: true })
  featureVoiceEnrollment?: boolean | null;

  @ApiPropertyOptional({ description: 'Override monitoring access feature; null = inherit', nullable: true })
  featureMonitoringAccess?: boolean | null;

  @ApiPropertyOptional({ description: 'Override model tier; null = inherit', nullable: true })
  modelTier?: string | null;

  @ApiPropertyOptional({ description: 'Override rate-limit tier; null = inherit', nullable: true })
  rateLimitTier?: string | null;

  @ApiPropertyOptional({ description: 'Per-tenant absolute rate override (req/min); null = use the tier', nullable: true })
  rateLimitPerMinute?: number | null;

  @ApiProperty({ description: 'OCC version token' })
  version: number;
}

/**
 * TASK-392 (Q1/Q7) — create-or-update a per-tenant override ("increase on
 * demand"). Every field is optional; a supplied `null` clears the override
 * (back to inherit). `expectedVersion` is REQUIRED only when updating an
 * existing override row (ignored on first create).
 */
export class UpsertTenantEntitlementRequest {
  @ApiPropertyOptional({ description: 'Override max users; null = inherit', nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  maxUsers?: number | null;

  @ApiPropertyOptional({ description: 'Override max departments; null = inherit', nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  maxDepartments?: number | null;

  @ApiPropertyOptional({ description: 'Override max prompt templates; null = inherit', nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  maxPromptTemplates?: number | null;

  @ApiPropertyOptional({ description: 'Override max ASR pipelines; null = inherit', nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  maxAsrPipelines?: number | null;

  @ApiPropertyOptional({ description: 'Override max API keys; null = inherit', nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  maxApiKeys?: number | null;

  @ApiPropertyOptional({ description: 'Override storage quota bytes; null = inherit', nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  storageQuotaBytes?: number | null;

  @ApiPropertyOptional({ description: 'Override max concurrent STT sessions; null = inherit', nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  maxConcurrentSessions?: number | null;

  @ApiPropertyOptional({ description: 'Override monthly consultations; null = inherit', nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  monthlyConsultations?: number | null;

  @ApiPropertyOptional({ description: 'Override monthly transcription minutes; null = inherit', nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  monthlyTranscriptionMinutes?: number | null;

  @ApiPropertyOptional({ description: 'Override monthly summaries; null = inherit', nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  monthlySummaries?: number | null;

  @ApiPropertyOptional({ description: 'Override DNA reports feature; null = inherit', nullable: true })
  @IsOptional()
  @IsBoolean()
  featureDnaReports?: boolean | null;

  @ApiPropertyOptional({ description: 'Override voice enrollment feature; null = inherit', nullable: true })
  @IsOptional()
  @IsBoolean()
  featureVoiceEnrollment?: boolean | null;

  @ApiPropertyOptional({ description: 'Override monitoring access feature; null = inherit', nullable: true })
  @IsOptional()
  @IsBoolean()
  featureMonitoringAccess?: boolean | null;

  @ApiPropertyOptional({ description: 'Override model tier; null = inherit', nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  modelTier?: string | null;

  @ApiPropertyOptional({ description: 'Override rate-limit tier; null = inherit', nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(50)
  rateLimitTier?: string | null;

  @ApiPropertyOptional({ description: 'Per-tenant absolute rate override (req/min); null = use the tier', nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  rateLimitPerMinute?: number | null;

  @ApiPropertyOptional({ description: 'Current row version (OCC). REQUIRED to update an existing override; ignored on create.', example: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  expectedVersion?: number;
}
