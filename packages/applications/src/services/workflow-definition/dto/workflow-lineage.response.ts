import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, MaxLength } from 'class-validator';
import { PaginatedQuery } from '../../../common/dto';
import { PaginatedResponse } from '../../../common';

/**
 * TASK-965 (OD-965-3) — the ACTIVE version of a workflow lineage: the one the dispatcher
 * resolves for new runs. `null` when nothing is active, which is the WARNING state the studio
 * and the assignment matrix must render — an assignment naming that slug resolves to nothing.
 */
export class WorkflowLineageActiveResponse {
  @ApiProperty() id!: string;
  @ApiProperty() versionNumber!: number;
  @ApiPropertyOptional({ nullable: true, description: 'ISO timestamp.' }) publishedAt!: string | null;
  @ApiPropertyOptional({ nullable: true, description: 'The user that published this version (`updatedBy`, stamped by publish).' })
  publishedBy!: string | null;
  @ApiPropertyOptional({ nullable: true, description: 'The node-registry checksum stamped at publish; compare against the running one for drift.' })
  registryChecksum!: string | null;
  @ApiPropertyOptional({ nullable: true }) compiledConfigChecksum!: string | null;
}

/** The newest OPEN version of a lineage — what "Continue draft vM" continues. */
export class WorkflowLineageDraftResponse {
  @ApiProperty() id!: string;
  @ApiProperty() versionNumber!: number;
  @ApiProperty({ enum: ['DRAFT', 'VALIDATED'] }) status!: string;
  @ApiProperty({ description: 'ISO timestamp.' }) updatedAt!: string;
}

/** What this SLUG serves, summarised. The assignment is per-SLUG, never per-version. */
export class WorkflowLineageAssignmentResponse {
  @ApiProperty({ description: 'The tenant tier’s UNQUALIFIED assignment for this palette names this slug.' }) tenantDefault!: boolean;
  @ApiProperty({ description: 'How many departments assign this slug.' }) departmentCount!: number;
  @ApiProperty({ description: 'How many TAG-QUALIFIED assignments (any tier) name this slug.' }) selectorCount!: number;
}

/** Reference-set provenance: the SYSTEM template this lineage was cloned from at provisioning. */
export class WorkflowLineageOriginResponse {
  @ApiPropertyOptional({ nullable: true }) sourceTemplateSlug!: string | null;
  @ApiProperty({ description: 'True when the tenant has not diverged, so a super-admin re-sync may refresh it.' }) templateLocked!: boolean;
}

/**
 * TASK-965 (OD-965-3) — ONE workflow LINEAGE (one slug), not one version row.
 *
 * `GET admin/workflow-definitions` pages per VERSION; the studio's switcher and the assignment
 * picker consume flat per-version lists that silently truncate. This is the register shape both
 * should read: the active pointer, the open draft, the counts and what the slug serves.
 */
export class WorkflowLineageResponse {
  @ApiProperty() slug!: string;
  @ApiProperty({ description: 'The ACTIVE version’s name, or the newest version’s when nothing is active.' }) name!: string;
  @ApiProperty() paletteKey!: string;
  @ApiProperty({ description: 'Live (non-deleted) version rows in this lineage.' }) versionCount!: number;
  @ApiProperty() latestVersionNumber!: number;
  @ApiProperty() deprecatedCount!: number;
  @ApiPropertyOptional({ type: WorkflowLineageActiveResponse, nullable: true }) active!: WorkflowLineageActiveResponse | null;
  @ApiPropertyOptional({ type: WorkflowLineageDraftResponse, nullable: true }) draft!: WorkflowLineageDraftResponse | null;
  @ApiProperty({ type: WorkflowLineageAssignmentResponse }) assignment!: WorkflowLineageAssignmentResponse;
  @ApiProperty({ type: WorkflowLineageOriginResponse }) origin!: WorkflowLineageOriginResponse;
  @ApiProperty({ type: [String] }) tags!: string[];
  @ApiProperty({ description: 'ISO timestamp — the newest touch anywhere in the lineage.' }) updatedAt!: string;
}

export class PaginatedWorkflowLineageResponse extends PaginatedResponse<WorkflowLineageResponse> {
  @ApiProperty({ type: [WorkflowLineageResponse] })
  override readonly data!: readonly WorkflowLineageResponse[];
}

/**
 * The lineage register's query. `paletteKey` is the same first-class narrowing
 * `ListWorkflowDefinitionsQuery` carries and is validated the same way; the inherited
 * `filters` / `search` narrow the VERSION rows, so a lineage is listed when any of its live
 * versions match.
 */
export class ListWorkflowLineagesQuery extends PaginatedQuery {
  @ApiPropertyOptional({ description: 'Only lineages on this palette. An unknown key is a 400 naming the known ones, never an empty page.', example: 'core' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  paletteKey?: string;
}
