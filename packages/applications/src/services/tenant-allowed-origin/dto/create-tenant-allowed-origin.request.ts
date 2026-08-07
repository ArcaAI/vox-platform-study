import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateTenantAllowedOriginRequest {
  /**
   * Raw origin as typed by the operator. Normalized server-side — the
   * caller does not need to pre-normalize (and normalization may change the
   * stored value, e.g. stripping a default `:443`/`:80` port). Validation is
   * NOT performed here: this DTO only enforces basic type/length; the real
   * grammar check is `normalizeOrigin()` / `normalizeOriginPattern()` in
   * `TenantAllowedOriginService`, routed by shape (TASK-610 §4A.2/§4A.3) —
   * `isOriginPattern(origin)` (true iff the value contains `*`) picks the
   * validator. Accepts THREE forms:
   *  - an EXACT origin: `scheme://host[:port]`
   *  - a wildcard PATTERN: `scheme://*.suffix:*` (or a pinned port/host)
   *  - the bare allow-all token `*` — admits every origin for the owning
   *    tenant; see `TenantAllowedOriginResponse` for the exposure this
   *    grants and how it is confined.
   */
  @ApiProperty({
    description:
      'Raw origin, normalized server-side. Accepts an EXACT origin (scheme://host[:port]), a wildcard PATTERN (scheme://*.suffix:*), or the bare allow-all token `*`. The caller does not need to pre-normalize.',
    example: 'https://arcaai-staging.bcmch.org',
    examples: {
      exact: 'https://arcaai-staging.bcmch.org',
      pattern: 'https://*.bcmch.org:*',
      allowAll: '*',
    },
  })
  @IsString()
  @IsNotEmpty()
  @MaxLength(2048)
  origin!: string;

  @ApiProperty({ description: 'Human-readable name for the admin list.', example: 'BCMCH pre-production' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(200)
  label!: string;

  @ApiPropertyOptional({ description: 'Optional operator note.' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;
}
