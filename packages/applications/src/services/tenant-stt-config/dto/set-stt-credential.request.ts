import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';

/**
 * Set/rotate a tenant's BYO STT provider API key. Write-only: the key is
 * Vault-Transit encrypted immediately and never returned by any read.
 * `region` is the classic Azure Speech region; `endpoint` is the Azure Foundry
 * resource / OpenAI-compatible base URL; `model` (Foundry model / Sarvam /
 * OpenAI model id) is persisted under `extraJson`. `expectedVersion` is the OCC
 * token (`0` = create, `>0` = compare-and-set; TASK-526 credential-OCC divergence
 * from the TTS precedent).
 */
export class SetSttCredentialRequest {
  @ApiProperty({ description: 'Provider API key (write-only; encrypted at rest, never returned)' })
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  apiKey!: string;

  @ApiPropertyOptional({ description: 'Classic Azure Speech region (e.g. eastus)' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  region?: string;

  @ApiPropertyOptional({ description: 'Azure Foundry resource / OpenAI-compatible base URL' })
  @IsOptional()
  @IsString()
  @MaxLength(512)
  endpoint?: string;

  @ApiPropertyOptional({ description: 'Provider model id (Foundry model / Sarvam / OpenAI); stored under extraJson' })
  @IsOptional()
  @IsString()
  @MaxLength(128)
  model?: string;

  @ApiPropertyOptional({ description: 'Enable this credential (default true)' })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiProperty({
    description: 'OCC token. 0 = create (no row yet); >0 = compare-and-set against the current version (412 on drift).',
    example: 0,
  })
  @IsInt()
  @Min(0)
  expectedVersion!: number;
}
