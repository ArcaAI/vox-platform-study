import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * TASK-496 — set/rotate a tenant's BYO provider API key. Write-only: the key is
 * Vault-Transit encrypted immediately and never returned by any read. `endpoint`
 * maps per provider (azure → region, sarvam → base URL).
 */
export class SetTtsCredentialRequest {
  @ApiProperty({ description: 'Provider API key (write-only; encrypted at rest, never returned)' })
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  apiKey!: string;

  @ApiPropertyOptional({ description: 'Provider endpoint — azure: region (e.g. eastus); sarvam: base URL' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  endpoint?: string;

  @ApiPropertyOptional({ description: 'Enable this credential for routing (default true)' })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
