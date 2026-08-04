import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmpty, IsOptional, IsString, MaxLength } from 'class-validator';

export class CreateTenantAllowedOriginRequest {
  /**
   * Raw origin as typed by the operator (e.g. `https://arcaai-staging.bcmch.org`).
   * Normalized server-side via `normalizeOrigin()` before persistence — the
   * caller does not need to pre-normalize (and normalization may change the
   * stored value, e.g. stripping a default `:443`/`:80` port).
   */
  @ApiProperty({ description: 'Raw origin (scheme://host[:port]); normalized server-side.', example: 'https://arcaai-staging.bcmch.org' })
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
