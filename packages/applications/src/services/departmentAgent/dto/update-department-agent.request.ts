import { IsString, IsOptional, IsObject, IsEnum, IsArray, IsInt, IsIn, MaxLength, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DepartmentAgentDnaPolicy, ResourceStatusType } from '@arcaai/domains';

/**
 * Update a DepartmentAgent. `departmentId` is identity and is NOT editable
 * here. Version PINNING has its own endpoint (`POST :id/pin`), so
 * `pinnedVersionNumber` is deliberately absent. Lineage columns
 * (`sourceAgentTemplateSlug`, `templateLocked`) are absent by design — the
 * whitelist pipe rejects any attempt to set them over the API.
 */
export class UpdateDepartmentAgentRequest {
  @ApiPropertyOptional({ description: 'Agent name' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  name?: string;

  @ApiPropertyOptional({ description: 'URL-friendly slug (unique per department)' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  slug?: string;

  @ApiPropertyOptional({ description: 'Agent description' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ description: 'Bound PromptTemplate id (tenant-visible)' })
  @IsOptional()
  @IsString()
  promptTemplateId?: string;

  @ApiPropertyOptional({ description: 'DNA writing-style gate', enum: DepartmentAgentDnaPolicy })
  @IsOptional()
  @IsEnum(DepartmentAgentDnaPolicy)
  dnaStylePolicy?: DepartmentAgentDnaPolicy;

  @ApiPropertyOptional({ description: 'Tenant-tier HarnessPolicy overrides (thresholds + maxRegen/gateSla/gateEscalation/toolAllowlist only)' })
  @IsOptional()
  @IsObject()
  harnessOverrides?: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Golden set id (consumed by eval gating)' })
  @IsOptional()
  @IsString()
  goldenSetId?: string;

  // ── TASK-635 RF-4 capability-keyed bindings. All optional; omitted/null ⇒ the
  // LEGACY behaviour for that capability. Every field must be declared here —
  // the gateway's global `forbidNonWhitelisted` pipe rejects undeclared fields,
  // so this is mandatory, not cosmetic. `templateLocked` stays deliberately
  // absent (existing posture) so it can never be flipped over the API.
  @ApiPropertyOptional({ description: 'Summary template served for NEW-PATIENT visits. Null ⇒ fall back to promptTemplateId.' })
  @IsOptional()
  @IsString()
  newPatientTemplateId?: string | null;

  @ApiPropertyOptional({ description: 'Summary template served for REVISIT visits. Null ⇒ fall back to promptTemplateId.' })
  @IsOptional()
  @IsString()
  revisitTemplateId?: string | null;

  @ApiPropertyOptional({
    description:
      'Pre-summary template for NATIVE requests that carry this department. Null ⇒ the tenant default, then the SYSTEM default. Never consulted by the v1-compat path (it sends no departmentId).',
  })
  @IsOptional()
  @IsString()
  preSummaryTemplateId?: string | null;

  @ApiPropertyOptional({ description: 'Live-summarization prompt template. Null ⇒ the SYSTEM live default.' })
  @IsOptional()
  @IsString()
  livePromptTemplateId?: string | null;

  @ApiPropertyOptional({
    description:
      'Which live-loop tools run: { version: 1, tools: { ner: { enabled }, vitals: { enabled }, groundedness: { enabled } } }. Null ⇒ platform default.',
  })
  @IsOptional()
  @IsObject()
  toolConfig?: Record<string, unknown> | null;

  @ApiPropertyOptional({
    description:
      'Per-task LLM override: { live?: { aiModelSlug }, finalize?: { aiModelSlug } }. Each key falls back independently to the tenant AiTaskDefault.',
  })
  @IsOptional()
  @IsObject()
  llmOverrides?: Record<string, unknown> | null;

  @ApiPropertyOptional({ description: 'Tags', type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional({ description: 'Resource status', enum: ['ENABLED', 'DISABLED'] })
  @IsOptional()
  @IsIn([ResourceStatusType.ENABLED, ResourceStatusType.DISABLED])
  resourceStatus?: ResourceStatusType;

  @ApiProperty({
    description: 'Current version of the row (from the prior GET). The PATCH fails with 412 if the version drifted.',
    example: 1,
  })
  @IsInt()
  @Min(1)
  expectedVersion!: number;
}
