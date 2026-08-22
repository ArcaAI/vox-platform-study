import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * One `WorkflowDefinition` row — which, per the model's file header, IS a version. Timestamps
 * are ISO-8601 strings (backend `Date` objects never cross the DTO boundary — rule 04).
 */
export class WorkflowDefinitionResponse {
  @ApiProperty()
  id: string;

  @ApiProperty()
  tenantId: string;

  @ApiProperty()
  slug: string;

  @ApiProperty()
  name: string;

  @ApiPropertyOptional({ nullable: true })
  description: string | null;

  @ApiProperty()
  paletteKey: string;

  @ApiProperty()
  versionNumber: number;

  @ApiPropertyOptional({ nullable: true, description: 'The published version this draft branched from, if any.' })
  parentVersionId: string | null;

  @ApiProperty({ enum: ['DRAFT', 'VALIDATED', 'PUBLISHED', 'DEPRECATED'] })
  status: string;

  @ApiProperty({ type: 'object', additionalProperties: true, description: 'The canvas graph, exactly as authored.' })
  graph: Record<string, unknown>;

  @ApiProperty()
  graphChecksum: string;

  @ApiPropertyOptional({
    nullable: true,
    type: 'object',
    additionalProperties: true,
    description: 'Server-produced interpreter input contract. Null until PUBLISHED.',
  })
  compiledConfig: Record<string, unknown> | null;

  @ApiPropertyOptional({ nullable: true })
  compiledConfigChecksum: string | null;

  @ApiPropertyOptional({ nullable: true })
  registryChecksum: string | null;

  @ApiPropertyOptional({ nullable: true, type: 'object', additionalProperties: true, description: 'The last server-side ValidationReport.' })
  validationReport: Record<string, unknown> | null;

  @ApiProperty({
    description:
      "The node registry checksum of the RUNNING server, for comparison against `registryChecksum` (the value stamped at publish). Present on every response so a client seeing `needsReview: true` can tell WHAT drifted, rather than only that something did.",
  })
  currentRegistryChecksum: string;

  @ApiProperty({
    description:
      'True when a published row is out of sync with the running node registry (checksum drift), or when the row was explicitly flagged. Derived on read — a published definition is immutable, so drift is never written back.',
  })
  needsReview: boolean;

  @ApiPropertyOptional({ nullable: true })
  validatedAt: string | null;

  @ApiPropertyOptional({ nullable: true })
  publishedAt: string | null;

  @ApiPropertyOptional({ nullable: true })
  deprecatedAt: string | null;

  @ApiProperty({ description: 'The movable pointer: the version the dispatcher resolves for new runs.' })
  isActive: boolean;

  @ApiProperty()
  resourceStatus: string;

  @ApiProperty()
  createdAt: string;

  @ApiProperty()
  updatedAt: string;

  @ApiProperty({ description: 'Optimistic-concurrency version (`_version`).' })
  version: number;

  @ApiProperty({ type: [String] })
  tags: string[];
}
