import { ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayUnique, IsArray, IsBoolean, IsIn, IsInt, IsOptional, IsString, IsUrl, Matches, MaxLength, Min } from 'class-validator';

/**
 * TASK-516 — sparse patch over a registered MCP server. Every field optional;
 * only supplied fields are written. `expectedVersion` is the OCC token (the
 * controller folds the RFC 7232 `If-Match` header over it). `authRef` stays a
 * Vault PATH only.
 */
export class UpdateMcpServerRequest {
  @ApiPropertyOptional({ description: 'Human-readable server name (unique per tenant)' })
  @IsOptional()
  @IsString()
  @MaxLength(120)
  name?: string;

  @ApiPropertyOptional({ description: 'Optional description', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiPropertyOptional({ description: 'MCP server root URL (streamable-HTTP endpoint)' })
  @IsOptional()
  @IsString()
  @IsUrl({ require_tld: false, require_protocol: true })
  baseUrl?: string;

  @ApiPropertyOptional({ description: 'Transport (only "streamable-http" supported)', enum: ['streamable-http'] })
  @IsOptional()
  @IsIn(['streamable-http'])
  transport?: string;

  @ApiPropertyOptional({ description: 'Vault PATH to the server credential — NEVER secret material.' })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Matches(/^[^\s]+$/, { message: 'authRef must be a Vault path (no whitespace / secret material).' })
  authRef?: string;

  @ApiPropertyOptional({ description: 'Per-server tool allow-list (tool ids).', type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayUnique()
  toolAllowlist?: string[];

  @ApiPropertyOptional({ description: 'PHI boundary', enum: ['external', 'in-boundary'] })
  @IsOptional()
  @IsIn(['external', 'in-boundary'])
  phiBoundary?: string;

  @ApiPropertyOptional({ description: 'Per-server runtime kill-switch.' })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @ApiPropertyOptional({ description: 'OCC token — compare-and-set against the current version (412 on drift).', example: 1 })
  @IsOptional()
  @IsInt()
  @Min(0)
  expectedVersion?: number;
}
