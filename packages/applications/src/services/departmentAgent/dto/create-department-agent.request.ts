import { IsString, IsOptional, IsObject, IsInt, IsEnum, IsArray, MaxLength, Min } from 'class-validator';
import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { DepartmentAgentDnaPolicy, DepartmentAgentRole } from '@arcaai/domains';

export class CreateDepartmentAgentRequest {
  @ApiProperty({ description: 'Department this agent belongs to' })
  @IsString()
  departmentId!: string;

  @ApiProperty({ description: 'Agent name', example: 'Cardiology SOAP' })
  @IsString()
  @MaxLength(100)
  name!: string;

  @ApiProperty({ description: 'URL-friendly slug (unique per department)', example: 'cardiology-soap' })
  @IsString()
  @MaxLength(100)
  slug!: string;

  @ApiPropertyOptional({ description: 'Agent description' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiProperty({ description: 'Bound PromptTemplate id (tenant-visible)' })
  @IsString()
  promptTemplateId!: string;

  @ApiPropertyOptional({
    description: 'Pin the agent to a specific PromptVersion number. Omit/null to track the latest APPROVED version.',
    example: 3,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  pinnedVersionNumber?: number | null;

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

  // ──  capability-keyed bindings. All optional; omitted/null ⇒ the
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

  // ──  loop configuration + promotion surface. All optional;
  // omitted/null ⇒ no loop participation for this agent (role still defaults
  // to SPECIALIST — see DepartmentAgentFactory).
  @ApiPropertyOptional({ description: 'Loop role — at most one ENABLED PRIMARY per department', enum: DepartmentAgentRole })
  @IsOptional()
  @IsEnum(DepartmentAgentRole)
  role?: DepartmentAgentRole;

  @ApiPropertyOptional({
    description: 'Context kinds this agent listens for: { version: 1, kinds: [{ key, filter? }] }. Kind keys are cross-checked against the resolved context schema.',
  })
  @IsOptional()
  @IsObject()
  subscribedKinds?: Record<string, unknown> | null;

  @ApiPropertyOptional({ description: 'Output kinds this agent may produce: { version: 1, outputs: ["soap_note"] }' })
  @IsOptional()
  @IsObject()
  writeScope?: Record<string, unknown> | null;

  @ApiPropertyOptional({
    description: 'Constrained goal (NOT a free-text prompt): { version: 1, objective, successCriteria? }',
  })
  @IsOptional()
  @IsObject()
  goal?: Record<string, unknown> | null;

  @ApiPropertyOptional({ description: 'Named guardrail profile from a closed platform catalogue' })
  @IsOptional()
  @IsString()
  guardrailProfile?: string | null;

  @ApiPropertyOptional({ description: 'Actions this agent must always take (compliance envelope)', type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  alwaysActions?: string[] | null;

  @ApiPropertyOptional({ description: 'Actions this agent must never take (compliance envelope)', type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  neverActions?: string[] | null;
}
