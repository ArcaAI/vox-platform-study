import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsObject, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';

/**
 * TASK-524 — upsert one (tenant, provider) connection row.
 *
 * Every accepted field is declared here: the global pipe runs
 * `whitelist + forbidNonWhitelisted`, so an undeclared field 400s.
 *
 * `apiKey` is WRITE-ONLY — it is Vault-Transit encrypted on the way in and is
 * NEVER returned by any read DTO (see `AiProviderConnectionResponse.hasKey`).
 */
export class UpsertAiProviderConnectionRequest {
  @ApiPropertyOptional({
    description: 'Base URL of the serving endpoint (ollama / lm-studio / vllm / llama-cpp / azure).',
    example: 'http://localhost:11434',
  })
  @IsOptional()
  @IsString()
  @MaxLength(2048)
  baseUrl?: string | null;

  @ApiPropertyOptional({ description: 'Region identifier (bedrock).', example: 'us-east-1' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  region?: string | null;

  @ApiPropertyOptional({ description: 'API version (azure).', example: '2024-10-21' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  apiVersion?: string | null;

  @ApiPropertyOptional({ description: 'Deployment name (azure).', example: 'gpt-4o-mini' })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  deploymentName?: string | null;

  @ApiPropertyOptional({
    description:
      'Plaintext API key. Vault-Transit encrypted at rest and NEVER returned by any read. ' +
      'Omit to leave the stored key untouched; the write is rejected when Vault is unavailable.',
  })
  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(512)
  apiKey?: string;

  @ApiPropertyOptional({
    description:
      'Whether this connection participates in resolution. A DISABLED row is skipped and ' +
      'resolution falls through to the SYSTEM row and then to the service env configuration.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ description: 'Provider-specific extras.', type: Object })
  @IsOptional()
  @IsObject()
  extraJson?: Record<string, unknown> | null;

  @ApiPropertyOptional({
    description:
      'Version the client read (optimistic concurrency). The `If-Match` header overrides this ' + 'when both are present. Use 0 to create.',
    example: 3,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedVersion?: number;
}
