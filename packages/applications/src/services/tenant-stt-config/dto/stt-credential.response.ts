import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Masked view of a tenant's BYO STT provider credential. NEVER carries the key. */
export class SttCredentialResponse {
  @ApiProperty({ description: 'Provider (azure-speech | sarvam | openai)' })
  provider!: string;

  @ApiPropertyOptional({ description: 'Classic Azure Speech region', nullable: true })
  region?: string | null;

  @ApiPropertyOptional({ description: 'Azure Foundry resource / OpenAI-compatible base URL', nullable: true })
  endpoint?: string | null;

  @ApiPropertyOptional({ description: 'Provider model id (from extraJson)', nullable: true })
  model?: string | null;

  @ApiProperty({ description: 'Whether this credential is enabled' })
  enabled!: boolean;

  @ApiProperty({ description: 'Whether an encrypted key is stored' })
  hasKey!: boolean;

  @ApiPropertyOptional({ description: 'Vault key version the ciphertext was sealed with', nullable: true })
  keyVersion?: number | null;

  @ApiProperty({ description: 'OCC version. Echo back as `If-Match: "<version>"` on the next write.', example: 1 })
  version!: number;

  @ApiPropertyOptional({ description: 'Last updated (ISO)' })
  updatedAt?: string;
}
