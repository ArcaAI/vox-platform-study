import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsIn, IsInt, IsObject, IsOptional, IsString, MaxLength, Min, MinLength } from 'class-validator';
import { CONNECTION_ENABLED_SEMANTICS } from '../constants';

/**
 * Upsert one (service, tenant, provider) connection row.
 *
 * Every accepted field is declared here: the global pipe runs
 * `whitelist + forbidNonWhitelisted`, so an undeclared field 400s.
 *
 * `apiKey` is WRITE-ONLY — it is Vault-Transit encrypted on the way in and is
 * NEVER returned by any read DTO (see `AiProviderConnectionResponse.hasKey`).
 *
 * The capability discriminator is authoritatively the `:service` PATH param on
 * the route (the service method takes it explicitly). It is also accepted here
 * (optional, validated) for symmetry and for callers/mocks that carry it in the
 * body; the path param wins.
 */
export class UpsertAiProviderConnectionRequest {
  @ApiPropertyOptional({
    description: 'Capability the connection serves. The route `:service` path param is authoritative.',
    enum: ['llm', 'stt', 'tts'],
    example: 'llm',
  })
  @IsOptional()
  @IsIn(['llm', 'stt', 'tts'])
  service?: 'llm' | 'stt' | 'tts';

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
    // TASK-643 R4 — `enabled: false` is a VETO, not merely "unused". The single
    // wording lives in `constants.ts` so the request DTO, the response DTO and
    // the controller's Swagger cannot drift apart on a rule an operator has to
    // reason about while debugging a 409.
    description: `Whether this connection participates in resolution. ${CONNECTION_ENABLED_SEMANTICS}`,
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
