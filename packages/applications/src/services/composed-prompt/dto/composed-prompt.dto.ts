import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';
import { IsIn, IsInt, IsNotEmpty, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

/** The egress locality a composed prompt was stamped with. */
export const COMPOSED_PROMPT_LOCALITIES = ['local', 'cloud'] as const;
export type ComposedPromptLocality = (typeof COMPOSED_PROMPT_LOCALITIES)[number];

/**
 * `POST internal/composed-prompts` — the harness records the messages it sent to `apps/text`.
 * The tenant comes from `X-Tenant-Id`, never from the body.
 */
export class RecordComposedPromptRequest {
  @ApiPropertyOptional({ format: 'uuid', description: 'The consultation the call generated for, when there is one.' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  consultationId?: string;

  @ApiPropertyOptional({ description: 'The agent whose instruction was composed, when there is one.', example: 'casenote-finalization' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  agentSlug?: string;

  @ApiProperty({
    description: 'Which generation this was. The harness sends `live`, `finalize`, `workflow` or `test`; the gateway also records `pre-summary`, `invoke` and others.',
    example: 'finalize',
    maxLength: 32,
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(32)
  phase!: string;

  @ApiProperty({ description: 'The provider the call was sent to.', example: 'lm-studio' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(64)
  provider!: string;

  @ApiProperty({ enum: COMPOSED_PROMPT_LOCALITIES, description: 'The egress locality the call was stamped with.' })
  @IsIn(COMPOSED_PROMPT_LOCALITIES)
  locality!: ComposedPromptLocality;

  @ApiProperty({ description: 'The composed SYSTEM message, verbatim. Stored as Vault-Transit ciphertext only.' })
  @IsString()
  system!: string;

  @ApiProperty({ description: 'The composed USER message, verbatim. Stored as Vault-Transit ciphertext only.' })
  @IsString()
  user!: string;
}

/** `202` — the record was accepted for an asynchronous, best-effort write. */
export class RecordComposedPromptAcceptedResponse {
  @ApiProperty({ example: true }) accepted!: boolean;
}

/** `GET admin/composed-prompts` — the query. */
export class ListComposedPromptsQuery {
  @ApiPropertyOptional({ format: 'uuid', description: 'Only the records of this consultation.' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  consultationId?: string;

  @ApiPropertyOptional({ description: 'Page number (starting from 1).', default: 1, minimum: 1 })
  @IsOptional()
  @Transform(({ value }) => parseInt(value, 10))
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({ description: 'Page size.', default: 20, minimum: 1, maximum: 100 })
  @IsOptional()
  @Transform(({ value }) => parseInt(value, 10))
  @IsInt()
  @Min(1)
  @Max(100)
  limit?: number;
}

/** One record's METADATA — never its messages. */
export class ComposedPromptSummaryResponse {
  @ApiProperty({ format: 'uuid' }) id!: string;
  @ApiProperty({ type: String, nullable: true, format: 'uuid' }) consultationId!: string | null;
  @ApiProperty({ type: String, nullable: true, example: 'casenote-finalization' }) agentSlug!: string | null;
  @ApiProperty({ example: 'finalize' }) phase!: string;
  @ApiProperty({ example: 'lm-studio' }) provider!: string;
  @ApiProperty({ enum: COMPOSED_PROMPT_LOCALITIES }) locality!: string;
  @ApiProperty({ description: 'SHA-256 (hex) of the plaintext `system + "\\n\\n" + user`.' }) sha256!: string;
  @ApiProperty({ description: 'ISO time the call was recorded.' }) createdAt!: string;
}

/** One record, DECRYPTED. */
export class ComposedPromptDetailResponse extends ComposedPromptSummaryResponse {
  @ApiProperty({ description: 'The composed SYSTEM message, as sent.' }) system!: string;
  @ApiProperty({ description: 'The composed USER message, as sent.' }) user!: string;
}

export class ComposedPromptPageResponse {
  @ApiProperty({ type: [ComposedPromptSummaryResponse] }) data!: ComposedPromptSummaryResponse[];
  @ApiProperty({ example: 42 }) count!: number;
  @ApiProperty({ example: 1 }) page!: number;
  @ApiProperty({ example: 20 }) limit!: number;
}
