import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { HarnessPolicySource } from '../../harness-policy/dto';

/**
 * (Phase 3A) item 6 — the effective agentic instruction set for one
 * tenant, aggregated read-only from the harness policy (thresholds + safety),
 * the prompt-resolution cascade (tier), and the vendored PDSQI judge-prompt pin.
 * Nothing here is editable through this surface: the policy is edited via
 * `/admin/harness/policy`, prompts via `/admin/prompt-templates`, and the judge
 * prompt is vendored (license/science) and exposed version/hash-only.
 */

/** The prompt tier that resolution picked (Tier-0 preferred → department → default). */
export class ResolvedPromptTierResponse {
  @ApiProperty({ description: 'Summary template resolved for the tenant/department (e.g. `SOAP`).' })
  template!: string;

  @ApiProperty({ description: 'Prompt registry id resolved for the (department, promptType).' })
  promptId!: string;

  @ApiProperty({ description: 'Which fallback tier provided the values.', enum: ['preferred', 'department', 'default'] })
  resolvedFrom!: 'preferred' | 'department' | 'default';

  @ApiPropertyOptional({ description: 'Department the tier was resolved against (null = tenant baseline).', nullable: true })
  departmentId!: string | null;

  @ApiProperty({ description: 'Prompt type the tier was resolved for.', example: 'new-patient' })
  promptType!: string;
}

/** The vendored PDSQI-9 LLM-as-judge prompt pin — read-only, non-editable. */
export class JudgePromptPinResponse {
  @ApiProperty({ description: 'Instrument name.', example: 'PDSQI-9' })
  instrument!: string;

  @ApiProperty({ description: 'Vendored instrument version pin.', example: '1.0.0' })
  version!: string;

  @ApiProperty({ description: 'Content fingerprint (sha256) over the pinned instrument identity + rubric surface.' })
  promptHash!: string;

  @ApiProperty({ description: 'Upstream open-source source.', example: 'epic-open-source/evaluation-instruments' })
  source!: string;

  @ApiProperty({ description: 'Upstream license.', example: 'Apache-2.0' })
  license!: string;

  @ApiProperty({ description: 'Validating publication DOI.', example: '10.1093/jamia/ocaf068' })
  paperDoi!: string;

  @ApiProperty({ description: 'The validated rubric dimensions the judge grades.', type: [String] })
  rubricDimensions!: string[];

  @ApiProperty({ description: 'Always false — the judge prompt is vendored and non-editable by license/science.', example: false })
  editable!: boolean;
}

/** The five clinical-loop sensor thresholds from the effective policy. */
export class SensorThresholdsResponse {
  @ApiProperty({ description: 'Entity-faithfulness sensor threshold.', example: 1.0 })
  entityFaithfulnessThreshold!: number;

  @ApiProperty({ description: 'Coverage sensor threshold.', example: 0.8 })
  coverageThreshold!: number;

  @ApiProperty({ description: 'Citation-presence sensor threshold.', example: 1.0 })
  citationPresenceThreshold!: number;

  @ApiProperty({ description: 'Numeric/dose sensor threshold.', example: 1.0 })
  numericDoseThreshold!: number;

  @ApiProperty({ description: 'Groundedness (inferential) sensor threshold.', example: 0.8 })
  groundednessThreshold!: number;
}

/** One safety criterion the loop enforces (derived from the effective policy). */
export class SafetyCriterionResponse {
  @ApiProperty({ description: 'Stable key.', example: 'safety' })
  key!: string;

  @ApiProperty({ description: 'Human label.', example: 'Content-safety guardrail' })
  label!: string;

  @ApiProperty({ description: 'Whether the criterion is currently enforced.', example: true })
  enabled!: boolean;

  @ApiPropertyOptional({ description: 'Extra context (e.g. provider/model, fail-closed posture).', nullable: true })
  detail!: string | null;
}

export class AgenticInstructionsResponse {
  @ApiProperty({ description: 'Tenant the effective instruction set was resolved for.' })
  tenantId!: string;

  @ApiProperty({ description: 'Where the effective policy was resolved from.', enum: ['tenant', 'system-default', 'code-default'] })
  policySource!: HarnessPolicySource;

  @ApiProperty({ description: 'The resolved prompt tier.', type: ResolvedPromptTierResponse })
  promptTier!: ResolvedPromptTierResponse;

  @ApiProperty({ description: 'The vendored (read-only) PDSQI judge-prompt pin.', type: JudgePromptPinResponse })
  judgePrompt!: JudgePromptPinResponse;

  @ApiProperty({ description: 'The effective sensor thresholds.', type: SensorThresholdsResponse })
  sensorThresholds!: SensorThresholdsResponse;

  @ApiProperty({ description: 'The effective safety criteria list.', type: [SafetyCriterionResponse] })
  safetyCriteria!: SafetyCriterionResponse[];
}
