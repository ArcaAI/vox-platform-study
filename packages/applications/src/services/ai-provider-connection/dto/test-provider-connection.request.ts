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
  /**
   * TASK-958 — WHICH VENDOR to probe, for a connection that is not saved yet.
   *
   * The path segment is a connection SLUG. For every pre-958 call it is also a
   * provider id, so the vendor is implied; for a NAMED sibling the operator is
   * testing (`openai-research`) nothing in the request says which vendor it
   * talks to until the row exists — and probing a vendor literally named
   * `openai-research` tests nothing at all. Send it on the create dialog's
   * "Test connection", exactly as `UpsertAiProviderConnectionRequest.provider`
   * is sent on save.
   *
   * On a SAVED connection the row already answers it: sending a DIFFERENT value
   * is a 409 (`CONNECTION_PROVIDER_IMMUTABLE`), never a probe of the stored key
   * against a vendor that did not issue it.
   */
  @ApiPropertyOptional({
    description:
      'Vendor this connection talks to (e.g. `openai`). Required when the slug is not itself a provider id and no row is saved yet; ' +
      'on a saved connection it must match the stored provider.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  provider?: string;

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
