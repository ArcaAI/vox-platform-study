import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** One check's outcome under the working tenant's rules. Names and scores only, never text. */
export class GuardrailScreenCheckResponse {
  @ApiProperty({ description: 'The check id.' })
  name!: string;

  @ApiProperty({ description: '`pass` | `flag` | `undetermined` | `skipped`.' })
  verdict!: string;

  @ApiPropertyOptional({ description: 'The action the rules set for a violation (`ignore` | `warn` | `block`).', nullable: true })
  action!: string | null;

  @ApiPropertyOptional({ description: 'What this screen actually did for this check.', nullable: true })
  actionTaken!: string | null;

  @ApiPropertyOptional({ nullable: true })
  score!: number | null;

  @ApiPropertyOptional({ nullable: true })
  category!: string | null;

  @ApiPropertyOptional({ description: 'A machine reason code, when the check gives one.', nullable: true })
  reason!: string | null;

  @ApiPropertyOptional({ description: 'The model that decided this check, when one did.', nullable: true })
  model!: string | null;
}

/** `POST admin/guardrail/screen` — the full verdict, as guardrail decided it for the working tenant. */
export class ScreenGuardrailRulesResponse {
  @ApiProperty({ enum: ['inbound', 'outbound'] })
  direction!: string;

  @ApiProperty({ description: 'The four-way guardrail decision.', enum: ['allow', 'warn', 'block', 'unverified'] })
  decision!: string;

  @ApiProperty({ type: [GuardrailScreenCheckResponse] })
  checks!: GuardrailScreenCheckResponse[];

  @ApiProperty({
    description: 'The `GuardrailNotice` v1 objects this screen raised (PHI-free, fixed messages).',
    type: 'array',
    items: { type: 'object' },
  })
  notices!: Record<string, unknown>[];

  @ApiPropertyOptional({ description: 'The guardrail evaluation record id (recorded with caller `playground`).', nullable: true })
  evaluationId!: string | null;

  @ApiPropertyOptional({ description: 'The guardrail policy version the verdict was decided under.', nullable: true })
  policyVersion!: string | null;
}
