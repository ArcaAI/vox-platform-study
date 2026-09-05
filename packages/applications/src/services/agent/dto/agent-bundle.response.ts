import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

export class AgentBundleSourceResponse {
  @ApiProperty({ enum: ['system', 'global', 'tenant'], description: 'The TIER the bundle came from — never a tenant id.' })
  tenantKind!: 'system' | 'global' | 'tenant';
  @ApiProperty() slug!: string;
  @ApiProperty() version!: number;
}

/**
 * A `PortableBundle` of kind `agent`. The payload is declared loosely on purpose: its shape is
 * owned by `@arcaai/workflow-contract` + `agent-bundle.ts`, and pinning every field twice in a
 * Swagger DTO is a second thing to keep in step for no reader's benefit.
 */
export class AgentBundleResponse {
  @ApiProperty({ example: 'agent' }) kind!: string;
  @ApiProperty({ description: 'Envelope version. A bundle newer than the importer is refused, never partially applied.' }) schemaVersion!: number;
  @ApiProperty({ description: 'ISO timestamp' }) exportedAt!: string;
  @ApiProperty({ type: AgentBundleSourceResponse }) source!: AgentBundleSourceResponse;
  @ApiProperty({
    type: 'object',
    additionalProperties: true,
    description: 'Values only: model references by slug, no credential, no server-owned column.',
  })
  payload!: Record<string, unknown>;
}

export class AgentSyncTargetResponse {
  @ApiProperty() tenantId!: string;
  @ApiProperty({ description: 'The DRAFT agent version created in that tenant.' }) agentId!: string;
  @ApiProperty() slug!: string;
  @ApiProperty() versionNumber!: number;
  @ApiPropertyOptional({ type: [String], description: 'What could not be carried across (a stripped eval gate, a re-resolved template).' })
  warnings!: string[];
}

export class AgentSyncResponse {
  @ApiProperty() sourceSlug!: string;
  @ApiProperty() sourceVersionNumber!: number;
  @ApiProperty({ type: [AgentSyncTargetResponse] }) targets!: AgentSyncTargetResponse[];
}
