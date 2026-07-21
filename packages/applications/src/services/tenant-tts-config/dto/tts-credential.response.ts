import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/** Masked view of a tenant's BYO provider credential. NEVER carries the key. */
export class TtsCredentialResponse {
  @ApiProperty({ description: 'Provider (azure | sarvam)' })
  provider!: string;

  @ApiPropertyOptional({ description: 'Endpoint — azure: region; sarvam: base URL', nullable: true })
  endpoint?: string | null;

  @ApiProperty({ description: 'Whether this credential is enabled for routing' })
  enabled!: boolean;

  @ApiProperty({ description: 'Whether an encrypted key is stored' })
  hasKey!: boolean;

  @ApiPropertyOptional({ description: 'Vault key version the ciphertext was sealed with', nullable: true })
  keyVersion?: number | null;

  @ApiPropertyOptional({ description: 'Last updated (ISO)' })
  updatedAt?: string;
}
