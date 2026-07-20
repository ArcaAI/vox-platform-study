import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsNumber, IsObject, IsOptional, Max, Min } from 'class-validator';

/**
 * TASK-524 — upsert one (SYSTEM, provider, modelSlug) runtime profile.
 *
 * EVERY field is optional and `null` means "no opinion — fall through the
 * cascade", NOT zero. Omitting a field on an update leaves the stored value
 * untouched; sending `null` explicitly clears it back to "no opinion".
 *
 * The ranges below are duplicated as service-layer clamps so a
 * service-to-service caller that bypasses the global validation pipe still
 * cannot write an out-of-range value.
 */
export class UpsertAiRuntimeProfileRequest {
  @ApiPropertyOptional({ description: 'Sampling temperature (0–2).', minimum: 0, maximum: 2, example: 0.2 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(2)
  temperature?: number | null;

  @ApiPropertyOptional({ description: 'Nucleus sampling top-p (0–1).', minimum: 0, maximum: 1, example: 0.95 })
  @IsOptional()
  @IsNumber()
  @Min(0)
  @Max(1)
  topP?: number | null;

  @ApiPropertyOptional({ description: 'Maximum tokens to generate.', minimum: 0, example: 2048 })
  @IsOptional()
  @IsInt()
  @Min(0)
  maxTokens?: number | null;

  @ApiPropertyOptional({
    description: 'Context window budget — `n_ctx` for GGUF engines, request context budget for API engines.',
    minimum: 0,
    example: 8192,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  contextLength?: number | null;

  @ApiPropertyOptional({ description: 'Maximum concurrent in-flight requests.', minimum: 0, example: 8 })
  @IsOptional()
  @IsInt()
  @Min(0)
  maxConcurrent?: number | null;

  @ApiPropertyOptional({ description: 'Tokens-per-minute limit.', minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  tpmLimit?: number | null;

  @ApiPropertyOptional({ description: 'Requests-per-minute limit.', minimum: 0 })
  @IsOptional()
  @IsInt()
  @Min(0)
  rpmLimit?: number | null;

  @ApiPropertyOptional({ description: 'Request timeout in seconds.', minimum: 0, example: 300 })
  @IsOptional()
  @IsInt()
  @Min(0)
  timeoutS?: number | null;

  @ApiPropertyOptional({
    description: 'Model-retention hint forwarded to server-managed engines (keep-alive seconds).',
    minimum: 0,
  })
  @IsOptional()
  @IsInt()
  @Min(0)
  keepAliveSeconds?: number | null;

  @ApiPropertyOptional({
    description: 'Engine-specific extras (n_threads, n_gpu_layers, num_predict, …).',
    type: Object,
  })
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
