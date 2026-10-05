import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsIn, IsOptional, IsString, MaxLength } from 'class-validator';

export const PROMPT_PREVIEW_PHASES = ['live', 'pre-summary', 'finalize'] as const;
export type PromptPreviewPhase = (typeof PROMPT_PREVIEW_PHASES)[number];

/** `POST admin/consultations/:consultationId/prompt-preview` — the request. */
export class PromptPreviewRequest {
  @ApiProperty({ enum: PROMPT_PREVIEW_PHASES, description: 'Which generation to compose the prompt of.' })
  @IsIn(PROMPT_PREVIEW_PHASES)
  phase!: PromptPreviewPhase;

  @ApiPropertyOptional({
    description: 'Compose this published TEXT_GENERATION agent`s instruction instead of the one the tenant`s chain resolves.',
    example: 'casenote-finalization',
  })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  agentSlug?: string;
}

export class PromptPreviewMessagesResponse {
  @ApiProperty({ description: 'The SYSTEM message.' }) system!: string;
  @ApiProperty({ description: 'The USER message.' }) user!: string;
}

export class PromptPreviewEgressResponse {
  @ApiProperty({
    type: 'object',
    additionalProperties: { type: 'number' },
    description: 'Detected identifiers by taxonomy label — counts only, never values.',
    example: { person: 2, medical_record_number: 1 },
  })
  detected!: Record<string, number>;

  @ApiProperty({ description: 'Occurrences a CLOUD call would replace with a token; 0 on a local call.', example: 3 })
  redacted!: number;
}

export class PromptPreviewTokenEstimateResponse {
  @ApiProperty({ description: 'Estimated tokens of the system message (characters ÷ 4, rounded up).', example: 812 }) system!: number;
  @ApiProperty({ description: 'Estimated tokens of the user message (characters ÷ 4, rounded up).', example: 2210 }) user!: number;
}

export class PromptPreviewExclusionResponse {
  @ApiProperty({ example: 'revisit' }) key!: string;
  @ApiProperty({ enum: ['condition_false', 'condition_error'] }) reason!: string;
}

export class PromptPreviewBlockResponse {
  @ApiProperty({ example: 'transcript' }) key!: string;
  @ApiProperty({ description: 'Characters of the block kept within its budget.', example: 5120 }) chars!: number;
  @ApiProperty({ description: 'Whether the block was cut to its budget.' }) truncated!: boolean;
}

/** `200` — the composed prompt for one consultation, as the provider would receive it. */
export class PromptPreviewResponse {
  @ApiProperty({ description: 'The composed SYSTEM message (platform rules, instruction, guidance).' }) system!: string;
  @ApiProperty({ description: 'The composed USER message (the delimited data sections).' }) user!: string;
  @ApiProperty({ enum: ['local', 'cloud'], description: 'The egress locality of the model that would serve the call; unknown is cloud.' })
  locality!: 'local' | 'cloud';
  @ApiPropertyOptional({
    type: PromptPreviewMessagesResponse,
    nullable: true,
    description: 'What a CLOUD provider would receive: identifiers pseudonymized as `[<LABEL>_<n>]`. `null` on a local call (sent as is).',
  })
  providerView!: PromptPreviewMessagesResponse | null;
  @ApiProperty({ type: PromptPreviewEgressResponse }) egressPreview!: PromptPreviewEgressResponse;
  @ApiProperty({ type: PromptPreviewTokenEstimateResponse }) tokenEstimate!: PromptPreviewTokenEstimateResponse;
  @ApiProperty({ description: 'Which tier of the prompt chain supplied the instruction.', example: 'agent' }) resolvedFrom!: string;
  @ApiProperty({ type: [String], description: 'Selected fragment keys of a composite instruction, in order.' }) selected!: string[];
  @ApiProperty({ type: [PromptPreviewExclusionResponse] }) excluded!: PromptPreviewExclusionResponse[];
  @ApiProperty({ type: [PromptPreviewBlockResponse], description: 'The data sections of the user message, in order.' })
  blocks!: PromptPreviewBlockResponse[];
}
