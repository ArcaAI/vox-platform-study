import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsObject, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { WORKFLOW_DEFINITION_SLUG_PATTERN } from '@arcaai/workflow-contract';

/**
 * `slug` follows `WORKFLOW_DEFINITION_SLUG_PATTERN` from `@arcaai/workflow-contract` —
 * lowercase alphanumerics, `-` and `_`, 2–80 chars. AMENDED: it used to reuse the
 * node-id grammar (`WORKFLOW_NODE_ID_PATTERN`, no hyphen), which rejected every seeded,
 * hyphenated lineage key (`platform-default-summarization`, `arcaai-consultation-soap`, …).
 *
 * `tenantId` is NEVER a field here — read from CLS by the service, and the global pipe's
 * `forbidNonWhitelisted` rejects a forged one. Server-owned columns
 * (`compiledConfig`/`compiledConfigChecksum`/`registryChecksum`/`status`/`publishedAt`/
 * `versionNumber`/`validationReport`/`isActive`) are likewise declared on NO request DTO here
 * (`workflow-definition.prisma`'s file header Layer 2 — the DTO whitelist is what makes
 * the immutability guard real).
 */
export class CreateWorkflowDefinitionRequest {
  @ApiProperty({ description: 'Stable tenant-invented lineage key, unique per (tenant, slug, versionNumber).', example: 'discharge_summary' })
  @IsString()
  @Matches(WORKFLOW_DEFINITION_SLUG_PATTERN, { message: 'slug must be 2-80 lowercase alphanumerics, - or _, starting and ending alphanumeric' })
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
