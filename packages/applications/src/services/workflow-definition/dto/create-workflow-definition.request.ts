import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsObject, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { WORKFLOW_NODE_ID_PATTERN } from '@arcaai/workflow-contract';

/**
 * `slug` reuses the platform-wide tenant-authored-key grammar
 * (`WORKFLOW_NODE_ID_PATTERN` from `@arcaai/workflow-contract`, itself mirroring
 * `AGENT_KIND_KEY_PATTERN`) — the same shape a graph node id must match, since both are
 * tenant-invented identifiers in the same substrate.
 *
 * `tenantId` is NEVER a field here — read from CLS by the service, and the global pipe's
 * `forbidNonWhitelisted` rejects a forged one. Server-owned columns
 * (`compiledConfig`/`compiledConfigChecksum`/`registryChecksum`/`status`/`publishedAt`/
 * `versionNumber`/`validationReport`/`isActive`) are likewise declared on NO request DTO here
 * (`workflow-definition.prisma`'s file header §3.4 Layer 2 — the DTO whitelist is what makes
 * the immutability guard real).
 */
export class CreateWorkflowDefinitionRequest {
  @ApiProperty({ description: 'Stable tenant-invented lineage key, unique per (tenant, slug, versionNumber).', example: 'discharge_summary' })
  @IsString()
  @Matches(WORKFLOW_NODE_ID_PATTERN, { message: 'slug must match [a-z0-9_]{2,48}' })
  slug: string;

  @ApiProperty({ description: 'Human-readable name.' })
  @IsString()
  @MaxLength(160)
  name: string;

  @ApiPropertyOptional({ description: 'Free-text description.' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiProperty({
    description: 'Which registered palette this definition targets (validated against the code-owned node registry).',
    example: 'summarization',
  })
  @IsString()
  @MaxLength(80)
  paletteKey: string;

  @ApiProperty({
    description: 'The canvas graph, exactly as authored — { version: 1, nodes: [...], edges: [...] }. Never executed directly.',
    type: 'object',
    additionalProperties: true,
  })
  @IsObject()
  graph: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'The published version this draft branches from (any version, not only the latest).' })
  @IsOptional()
  @IsString()
  parentVersionId?: string;
}
