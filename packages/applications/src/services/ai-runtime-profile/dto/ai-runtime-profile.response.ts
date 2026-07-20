import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** TASK-524 — read view of one (SYSTEM, provider, modelSlug) runtime profile. */
export class AiRuntimeProfileResponse {
  @ApiProperty({ description: 'Owning tenant — always the reserved SYSTEM tenant in this program.' })
  tenantId!: string;

  @ApiProperty({ description: 'Serving provider identifier.', example: 'lm-studio' })
  provider!: string;

  @ApiProperty({
    description: 'Model slug this profile applies to. Empty string = the provider-level default.',
    example: 'gemma-4-e2b-it-qat',
  })
  modelSlug!: string;

  @ApiProperty({ description: 'Sampling temperature. Null = no opinion.', nullable: true })
  temperature!: number | null;

  @ApiProperty({ description: 'Nucleus sampling top-p. Null = no opinion.', nullable: true })
  topP!: number | null;

  @ApiProperty({ description: 'Maximum tokens to generate. Null = no opinion.', nullable: true })
  maxTokens!: number | null;

  @ApiProperty({ description: 'Context window budget. Null = no opinion.', nullable: true })
  contextLength!: number | null;

  @ApiProperty({ description: 'Maximum concurrent requests. Null = no opinion.', nullable: true })
  maxConcurrent!: number | null;

  @ApiProperty({ description: 'Tokens-per-minute limit. Null = no opinion.', nullable: true })
  tpmLimit!: number | null;

  @ApiProperty({ description: 'Requests-per-minute limit. Null = no opinion.', nullable: true })
  rpmLimit!: number | null;

  @ApiProperty({ description: 'Request timeout in seconds. Null = no opinion.', nullable: true })
  timeoutS!: number | null;

  @ApiProperty({ description: 'Keep-alive/retention hint in seconds. Null = no opinion.', nullable: true })
  keepAliveSeconds!: number | null;

  @ApiProperty({ description: 'Engine-specific extras.', nullable: true, type: Object })
  extraJson!: Record<string, unknown> | null;

  @ApiProperty({ description: 'Row version for optimistic concurrency. 0 when no row exists yet.' })
  version!: number;

  @ApiPropertyOptional({ description: 'Last update timestamp (ISO 8601).' })
  updatedAt?: string;
}
