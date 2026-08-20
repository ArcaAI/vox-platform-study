import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * A read-only projection of one `WORKFLOW_NODE_REGISTRY` entry
 * (`@arcaai/workflow-contract`'s `WorkflowNodeDescriptor`) — the platform's whole node
 * vocabulary, tenant-visible by design (`admin:workflow-node:read`; see TASK-715 §6 risk #4:
 * "a node type's `description` is tenant-visible copy"). No table, no migration — this
 * package's zero-deps registry IS the source of truth (TASK-734 §6).
 */
export class WorkflowNodeResponse {
  @ApiProperty({ description: 'The node type string authored on a graph node.' })
  type: string;

  @ApiProperty({ description: 'False = an OBSERVABLE, non-executable placeholder — never silently dropped from the list.' })
  implemented: boolean;

  @ApiProperty({ description: 'The Temporal-registered activity name the compiler stamps into compiledConfig.' })
  activityName: string;

  @ApiProperty({ type: [String] })
  classes: string[];

  @ApiPropertyOptional({ nullable: true, description: 'The palette this node type belongs to, or null for a palette-agnostic utility node.' })
  paletteKey: string | null;

  @ApiProperty({ description: 'Code-owned safety property — never tenant-configurable.' })
  critical: boolean;

  @ApiProperty({ description: 'Code-owned safety property — never tenant-configurable.' })
  externalWrite: boolean;

  @ApiProperty()
  defaultTimeoutSeconds: number;

  @ApiProperty()
  defaultMaxAttempts: number;

  @ApiPropertyOptional({ nullable: true, description: 'The EntitlementFeatureKey that gates this node type, if any.' })
  entitlementKey: string | null;

  @ApiPropertyOptional({
    type: 'object',
    additionalProperties: true,
    nullable: true,
    description:
      'The node type’s config JSON Schema (authorable subset), or null when none has been authored for it yet — a real, structural state, not every node type has one.',
  })
  configSchema: Record<string, unknown> | null;
}

export class WorkflowNodeRegistryResponse {
  @ApiProperty({ type: [WorkflowNodeResponse] })
  nodes: WorkflowNodeResponse[];

  @ApiProperty({ description: 'sha256 of the registry — compared against a published definition’s stamped registryChecksum to detect drift.' })
  registryChecksum: string;
}
