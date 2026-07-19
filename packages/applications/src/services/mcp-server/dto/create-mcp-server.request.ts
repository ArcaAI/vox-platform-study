import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayUnique, IsArray, IsBoolean, IsIn, IsNotEmpty, IsOptional, IsString, IsUrl, Matches, MaxLength } from 'class-validator';

/**
 * TASK-516 — register a new MCP external-tools server.
 *
 * `authRef` is a Vault PATH ONLY (validated to be path-like — no whitespace, no
 * obvious secret material). Secrets flow through the TASK-504 Vault path, never
 * this request body. Feature stays OFF by default: `enabled` defaults false and
 * the whole path is additionally gated by `HarnessPolicy.mcpToolsEnabled`.
 */
export class CreateMcpServerRequest {
  @ApiProperty({ description: 'Human-readable server name (unique per tenant)', example: 'fhir-terminology' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(120)
  name!: string;

  @ApiPropertyOptional({ description: 'Optional description', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  description?: string;

  @ApiProperty({ description: 'MCP server root URL (streamable-HTTP endpoint)', example: 'https://terminology.internal/mcp' })
  @IsString()
  @IsNotEmpty()
  @IsUrl({ require_tld: false, require_protocol: true })
  baseUrl!: string;

  @ApiPropertyOptional({ description: 'Transport (only "streamable-http" supported)', enum: ['streamable-http'], default: 'streamable-http' })
  @IsOptional()
  @IsIn(['streamable-http'])
  transport?: string;

  @ApiPropertyOptional({
    description: 'Vault PATH to the server credential — NEVER secret material (path-like: no whitespace).',
    example: 'secret/data/mcp/terminology',
  })
  @IsOptional()
  @IsString()
  @MaxLength(200)
  // Defence in depth: reject anything with whitespace (an inline secret smell).
  @Matches(/^[^\s]+$/, { message: 'authRef must be a Vault path (no whitespace / secret material).' })
  authRef?: string;

  @ApiPropertyOptional({ description: 'Per-server tool allow-list (tool ids).', type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  @ArrayUnique()
  toolAllowlist?: string[];

  @ApiPropertyOptional({ description: 'PHI boundary', enum: ['external', 'in-boundary'], default: 'external' })
  @IsOptional()
  @IsIn(['external', 'in-boundary'])
  phiBoundary?: string;

  @ApiPropertyOptional({ description: 'Per-server runtime kill-switch (default false = dormant).', default: false })
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;
}
