import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { AgentTask } from '@arcaai/domains';
import { PaginatedResponse } from '../../../common';

/**
 * TASK-965 (OD-965-3) — the ACTIVE version of a lineage: the one PUBLISHED row the tenant is
 * serving. `null` on the lineage when nothing is active (the active version was deprecated or
 * deleted), which is a WARNING state on the row, not an empty cell.
 */
export class AgentLineageActiveResponse {
  @ApiProperty() id!: string;
  @ApiProperty() versionNumber!: number;
  @ApiPropertyOptional({ nullable: true, description: 'ISO timestamp.' }) publishedAt!: string | null;
  @ApiPropertyOptional({ nullable: true, description: 'The user that published this version (`updatedBy`, stamped by publish).' })
  publishedBy!: string | null;
  @ApiPropertyOptional({ nullable: true }) modelSlug!: string | null;
  @ApiPropertyOptional({ nullable: true }) compiledConfigChecksum!: string | null;
}

/** The newest OPEN version of a lineage — what "Continue draft vM" continues. `null` when none is open. */
export class AgentLineageDraftResponse {
  @ApiProperty() id!: string;
  @ApiProperty() versionNumber!: number;
  @ApiProperty({ enum: ['DRAFT', 'VALIDATED'] }) status!: string;
  @ApiProperty({ description: 'ISO timestamp.' }) updatedAt!: string;
}

/**
 * What this SLUG serves, summarised. The assignment is per-SLUG, never per-version (AG-15): a
 * DRAFT v4 of an assigned slug is not itself serving anything, and a badge on the version row
 * said it was.
 */
export class AgentLineageAssignmentResponse {
  @ApiProperty({ description: 'The tenant tier’s UNQUALIFIED assignment for this task names this slug.' }) tenantDefault!: boolean;
  @ApiProperty({ description: 'How many departments assign this slug.' }) departmentCount!: number;
  @ApiProperty({ description: 'How many TAG-QUALIFIED assignments (any tier) name this slug.' }) selectorCount!: number;
}

/** Reference-set provenance. A SYSTEM `sourceTenantId` is the "from platform" badge. */
export class AgentLineageOriginResponse {
  @ApiPropertyOptional({ nullable: true }) sourceTenantId!: string | null;
  @ApiPropertyOptional({ nullable: true }) sourceSlug!: string | null;
}

/**
 * TASK-965 (OD-965-3) — ONE agent LINEAGE (one slug), not one version row.
 *
 * `GET admin/agents` answers one row per VERSION, which is the right shape for a Versions tab
 * and the wrong shape for a list: the console rendered four near-identical rows for one agent,
 * counted versions where it meant agents, and could split a lineage across a page boundary. This
 * projection is the list shape — the active pointer, the open draft, the counts, and what the
 * slug serves, in one row.
 */
export class AgentLineageResponse {
  @ApiProperty() slug!: string;
  @ApiProperty({ description: 'The ACTIVE version’s name, or the newest version’s when nothing is active.' }) name!: string;
  @ApiProperty({ enum: AgentTask }) task!: AgentTask;
  @ApiProperty({ description: 'Live (non-deleted) version rows in this lineage.' }) versionCount!: number;
  @ApiProperty() latestVersionNumber!: number;
  @ApiProperty() deprecatedCount!: number;
  @ApiPropertyOptional({ type: AgentLineageActiveResponse, nullable: true }) active!: AgentLineageActiveResponse | null;
  @ApiPropertyOptional({ type: AgentLineageDraftResponse, nullable: true }) draft!: AgentLineageDraftResponse | null;
  @ApiProperty({ type: AgentLineageAssignmentResponse }) assignment!: AgentLineageAssignmentResponse;
  @ApiProperty({ type: AgentLineageOriginResponse }) origin!: AgentLineageOriginResponse;
  @ApiProperty({ type: [String] }) tags!: string[];
  @ApiProperty({ description: 'A platform service agent (allow-listed slug) the business plane never lists; admin surfaces render it flagged, never as a tenant’s own lineage.' }) hidden!: boolean;
  @ApiProperty({ description: 'ISO timestamp — the newest touch anywhere in the lineage.' }) updatedAt!: string;
}

export class PaginatedAgentLineageResponse extends PaginatedResponse<AgentLineageResponse> {
  @ApiProperty({ type: [AgentLineageResponse] })
  override readonly data!: readonly AgentLineageResponse[];
}
