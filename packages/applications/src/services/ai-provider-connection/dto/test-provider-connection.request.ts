import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

/**
 * TASK-862 — ephemeral "Test connection" probe body for
 * `POST admin/providers/:service/:provider/test`.
 *
 * NEVER PERSISTED: no `expectedVersion`, no Vault write, no OCC. Every field is
 * optional — an omitted field falls back to the STORED row (tenant → SYSTEM) so
 * an operator can re-test a saved key without re-entering it (the saved key is
 * write-only and never returned). Supplying `apiKey` tests THAT key instead.
 */
export class TestProviderConnectionRequest {
  @ApiPropertyOptional({ description: 'Provider API key to probe (never persisted). Omit to probe the stored key.' })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  apiKey?: string;

  @ApiPropertyOptional({ description: 'Endpoint / base URL to probe. Omit to use the stored row.' })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  baseUrl?: string;

  @ApiPropertyOptional({ description: 'Region (classic Azure Speech, Bedrock). Omit to use the stored row.' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  region?: string;

  @ApiPropertyOptional({ description: 'API version (Azure OpenAI). Omit to use the stored row.' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  apiVersion?: string;

  @ApiPropertyOptional({ description: 'Deployment name (Azure OpenAI) — verified against the listed deployments when given.' })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  deploymentName?: string;
}
