import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export const GUARDRAIL_TYPES = ['content_safety', 'pii_detection', 'prompt_injection', 'comprehensive'] as const;
export type GuardrailType = (typeof GUARDRAIL_TYPES)[number];

/**
 * Agent Playground → Guardrails tab (TASK-446). Proxied to the Guardrail
 * service `POST /api/guardrail/analyze`; the controller maps `guardrailType`
 * to the upstream snake_case `guardrail_type`.
 */
export class AnalyzeGuardrailRequest {
  @ApiProperty({ description: 'Text to analyze for content safety / PII / prompt injection.', maxLength: 20_000 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(20_000)
  text!: string;

  @ApiPropertyOptional({
    description: 'Type of guardrail check. Defaults to "comprehensive".',
    enum: GUARDRAIL_TYPES,
    default: 'comprehensive',
  })
  @IsOptional()
  @IsIn(GUARDRAIL_TYPES)
  guardrailType?: GuardrailType;
}
