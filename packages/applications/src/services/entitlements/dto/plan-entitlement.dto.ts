import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { TenantPlan } from '@arcaai/domains';

/**
 * A per-plan default-matrix row as returned to super-admins.
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
  /** @deprecated TASK-861 — removed in R4 with `AsrPipeline`; placeholder alias of the agent ceiling (TASK-863). */
  maxAsrPipelines?: number | null;

  @ApiPropertyOptional({ description: 'Max API keys; null = unlimited', nullable: true })
  maxApiKeys?: number | null;

  @ApiPropertyOptional({ description: 'Max PUBLISHED workflow definitions ; null = unlimited', nullable: true })
  maxWorkflowDefinitions?: number | null;

  @ApiPropertyOptional({
    description: 'Max AI provider connections a tenant on this plan may hold (per tenant, all services); null = unlimited',
    nullable: true,
  })
  maxAiProviderConnections?: number | null;

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

  @ApiPropertyOptional({
    description: 'Monthly PUBLISHED-workflow invocations via /api/v1/workflows/:slug/invoke ; null = unlimited',
    nullable: true,
  })
  monthlyWorkflowInvocations?: number | null;

  @ApiPropertyOptional({ description: 'Monthly STT session-seconds allowance (D11); null = unlimited', nullable: true })
  monthlySttSessionSeconds?: number | null;

  @ApiPropertyOptional({ description: 'Monthly LLM tokens allowance, all billable kinds summed (D11); null = unlimited', nullable: true })
  monthlyLlmTokens?: number | null;

  @ApiPropertyOptional({ description: 'Monthly TTS characters allowance, Unicode code points (D11); null = unlimited', nullable: true })
  monthlyTtsCharacters?: number | null;

  @ApiPropertyOptional({ description: 'Monthly NLP text-units allowance (D11); null = unlimited', nullable: true })
  monthlyNlpTextUnits?: number | null;

  @ApiPropertyOptional({ description: 'Monthly embedding tokens allowance (D11); null = unlimited', nullable: true })
  monthlyEmbeddingTokens?: number | null;

  @ApiProperty({
    description:
      "May this plan's tenants consume the PLATFORM-DEFAULT (SYSTEM-tenant) provider credential when they hold no key of their own? ENFORCED — it decides platform SPEND. false on every plan — the grant is issued per tenant via the tenant-entitlement override.",
  })
  featurePlatformDefaultCredential: boolean;

  @ApiProperty({ description: 'Model-access tier (base | full | full_custom)' })
  modelTier: string;

  @ApiProperty({ description: 'Rate-limit tier (strict | default | relaxed | heavy)' })
  rateLimitTier: string;

  @ApiPropertyOptional({
    description: 'ABSOLUTE requests-per-window for every tenant on this plan. Null = the plan expresses its limit through `rateLimitTier`.',
    nullable: true,
  })
  rateLimitPerMinute?: number | null;

  @ApiPropertyOptional({ description: 'Window paired with `rateLimitPerMinute`. Read only when that is set.', nullable: true })
  rateLimitWindowMs?: number | null;

  @ApiProperty({ description: 'OCC version token' })
  version: number;
}

/**
 * Super-admin edit of a per-plan default row. Every field is
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
  /** @deprecated TASK-861 — removed in R4 with `AsrPipeline`; placeholder alias of the agent ceiling (TASK-863). */
  maxAsrPipelines?: number | null;

  @ApiPropertyOptional({ description: 'Max API keys; null = unlimited', nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  maxApiKeys?: number | null;

  @ApiPropertyOptional({ description: 'Max PUBLISHED workflow definitions ; null = unlimited', nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  maxWorkflowDefinitions?: number | null;

  @ApiPropertyOptional({
    description: 'Max AI provider connections a tenant on this plan may hold (per tenant, all services); null = unlimited',
    nullable: true,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  maxAiProviderConnections?: number | null;

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

  @ApiPropertyOptional({
    description: 'Monthly PUBLISHED-workflow invocations via /api/v1/workflows/:slug/invoke ; null = unlimited',
    nullable: true,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  monthlyWorkflowInvocations?: number | null;

  @ApiPropertyOptional({ description: 'Monthly STT session-seconds allowance (D11); null = unlimited', nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  monthlySttSessionSeconds?: number | null;

  @ApiPropertyOptional({ description: 'Monthly LLM tokens allowance, all billable kinds summed (D11); null = unlimited', nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  monthlyLlmTokens?: number | null;

  @ApiPropertyOptional({ description: 'Monthly TTS characters allowance, Unicode code points (D11); null = unlimited', nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  monthlyTtsCharacters?: number | null;

  @ApiPropertyOptional({ description: 'Monthly NLP text-units allowance (D11); null = unlimited', nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  monthlyNlpTextUnits?: number | null;

  @ApiPropertyOptional({ description: 'Monthly embedding tokens allowance (D11); null = unlimited', nullable: true })
  @IsOptional()
  @IsInt()
  @Min(0)
  monthlyEmbeddingTokens?: number | null;

  @ApiPropertyOptional({
    description:
      "Grant this plan's tenants the PLATFORM-DEFAULT (SYSTEM-tenant) provider credential. Platform SPEND, not a display flag — a plan-level grant funds cloud calls for every tenant on the tier. Prefer the per-tenant override.",
  })
  @IsOptional()
  @IsBoolean()
  featurePlatformDefaultCredential?: boolean;

  @ApiPropertyOptional({
    description:
      'Does this plan include the harness AGENTIC LOOP ? ENFORCED, not display-only — LoopContextSignalService resolves it before every loop signal. false on STARTER, true on TRIAL/PRO/ENTERPRISE.',
  })
  @IsOptional()
  @IsBoolean()
  featureAgenticLoop?: boolean;

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

  @ApiPropertyOptional({
    description: 'ABSOLUTE requests-per-window for this plan. Send `null` to clear it and fall back to `rateLimitTier`.',
    minimum: 1,
    nullable: true,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  rateLimitPerMinute?: number | null;

  @ApiPropertyOptional({ description: 'Window paired with `rateLimitPerMinute`, in milliseconds.', minimum: 1, nullable: true })
  @IsOptional()
  @IsInt()
  @Min(1)
  rateLimitWindowMs?: number | null;

  @ApiProperty({ description: 'Current row version (OCC). REQUIRED; the update fails with 412 on drift.', example: 1 })
  @IsInt()
  @Min(1)
  expectedVersion: number;
}
