import { ApiPropertyOptional } from '@nestjs/swagger';
import {
  IsBoolean,
  IsIn,
  IsInt,
  IsObject,
  IsOptional,
  IsString,
  MaxLength,
  Min,
  MinLength,
  Validate,
  ValidationArguments,
  ValidatorConstraint,
  ValidatorConstraintInterface,
} from 'class-validator';
import { CONNECTION_ENABLED_SEMANTICS, PROVIDER_SERVICES, ProviderService } from '../constants';
import { PROVIDER_EXTRA_LIMITS, validateProviderExtras } from '../provider-extras';

/**
 * C.2 — `extraJson` was a bare `@IsObject()`, so anything at all
 * could be stored and then silently dropped in transit. It is now shape-checked
 * on the way IN, which is what makes the read-side passthrough safe: the wire
 * envelope stays flat and bounded, and the keys the connection row itself owns
 * (the credential, the endpoint, the derived `funding` label) cannot be
 * restated here. The check validates SHAPE, never a key vocabulary — a new
 * provider quirk must not require a code change.
 */
@ValidatorConstraint({ name: 'providerExtrasShape', async: false })
class ProviderExtrasShapeConstraint implements ValidatorConstraintInterface {
  validate(value: unknown): boolean {
    return validateProviderExtras(value).length === 0;
  }

  defaultMessage(args: ValidationArguments): string {
    // Echo the VIOLATIONS, never the value — extras may carry operator-sensitive
    // identifiers, and a 400 body is the wrong place to reflect stored input.
    return `extraJson is not a valid provider-extras object: ${validateProviderExtras(args.value).join('; ')}`;
  }
}

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
    enum: PROVIDER_SERVICES,
    example: 'llm',
  })
  @IsOptional()
  @IsIn(PROVIDER_SERVICES)
  service?: ProviderService;

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
    // `enabled: false` is a VETO, not merely "unused". The single
    // wording lives in `constants.ts` so the request DTO, the response DTO and
    // the controller's Swagger cannot drift apart on a rule an operator has to
    // reason about while debugging a 409.
    description: `Whether this connection participates in resolution. ${CONNECTION_ENABLED_SEMANTICS}`,
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({
    description:
      'Provider-specific extras, forwarded VERBATIM to the serving adapter as part of the per-request override ' +
      'entry. A FLAT object: values must be strings, numbers, booleans, or arrays of those — nested objects are ' +
      `rejected. At most ${PROVIDER_EXTRA_LIMITS.maxKeys} keys; strings up to ${PROVIDER_EXTRA_LIMITS.maxStringLength} ` +
      'characters. The keys the connection row itself supplies (`api_key`, `funding`, `base_url`, `region`, ' +
      '`api_version`, `deployment_name`) are reserved and rejected here.',
    type: Object,
    example: { json_response_format: true, reasoning_mode: 'medium' },
  })
  @IsOptional()
  @IsObject()
  @Validate(ProviderExtrasShapeConstraint)
  extraJson?: Record<string, unknown> | null;

  @ApiPropertyOptional({
    description:
      'Ceiling — simultaneous in-flight requests on this connection (TASK-862, moved from the retired runtime profiles). ' +
      'Null/omitted = no opinion; a positive integer is a hard cap.',
    nullable: true,
    example: 8,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  maxConcurrent?: number | null;

  @ApiPropertyOptional({ description: 'Ceiling — requests per minute. Null/omitted = no opinion.', nullable: true, example: 600 })
  @IsOptional()
  @IsInt()
  @Min(1)
  rpmLimit?: number | null;

  @ApiPropertyOptional({
    description: 'Ceiling — tokens per minute (LLM/embeddings; characters for TTS). Null/omitted = no opinion.',
    nullable: true,
    example: 200000,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  tpmLimit?: number | null;

  @ApiPropertyOptional({ description: 'Ceiling — per-request timeout in seconds. Null/omitted = no opinion.', nullable: true, example: 60 })
  @IsOptional()
  @IsInt()
  @Min(1)
  timeoutS?: number | null;

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
