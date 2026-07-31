import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * Ephemeral "Test connection" probe body. Mirrors `SetSttCredentialRequest`'s
 * key/region/endpoint shape but is NEVER PERSISTED — no `expectedVersion`, no
 * Vault write, no OCC. Lets a tenant admin validate a key + URL BEFORE saving
 * it (or independent of whether it was ever saved, since the saved key is
 * write-only and never returned for the form to re-test). Mirrors the house
 * "probe when possible, config-consistency smoke test otherwise" pattern from
 * `TenantIdpConfigService.testConnection`.
 */
export class TestSttCredentialRequest {
  @ApiProperty({ description: 'Provider API key to probe (never persisted)' })
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  apiKey!: string;

  @ApiPropertyOptional({ description: 'Classic Azure Speech region (e.g. eastus)' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  region?: string;

  @ApiPropertyOptional({ description: 'Azure Foundry resource / OpenAI-compatible / Sarvam base URL to probe' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  endpoint?: string;
}
