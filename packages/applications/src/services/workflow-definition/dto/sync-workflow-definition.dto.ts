import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, ArrayMinSize, IsArray, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

/**
 * TASK-885 (owner #4) — "a tenant admin who manages several tenants promotes/syncs among their
 * OWN tenants".
 *
 * SYNC IS NOT PROMOTION. Promotion (`POST admin/agent-promotions`) is a privileged, elevated,
 * tenant-less cross-boundary push that writes a WORM audit record; it exists so the PLATFORM can
 * move a workflow between two tenants it does not belong to. Sync is the multi-tenant CUSTOMER
 * admin's own operation: one person, several tenants they already administer, one workflow they
 * authored, pushed to the rest of their estate.
 *
 * What makes it safe is the same thing that makes promotion safe and is stated once here so the
 * two never drift: **the actor must hold `manage:WorkflowDefinition` in every named tenant**, and
 * a tenant they do not manage is a **404** — indistinguishable from a tenant id that does not
 * exist, so this route can never be used to enumerate the deployment's tenants.
 *
 * Each target receives a DRAFT recompiled against ITS OWN catalogue, never the source's
 * `compiledConfig`. A sync that published into another tenant would be one admin silently
 * re-pointing another tenant's live consultations.
 */
export class SyncWorkflowDefinitionRequest {
  @ApiProperty({
    description:
      'Tenant the workflow is synced FROM. Required — and required for the reason `PromoteWorkflowRequest.fromTenantId` is: ' +
      'deriving it would force a read BEFORE authorization, and the 403/404 difference between "that workflow does not exist" ' +
      'and "you may not touch that tenant" would then be an existence oracle over another tenant’s data.',
  })
  @IsString()
  sourceTenantId: string;

  @ApiProperty({
    description: 'Tenants to sync INTO. The caller must hold manage:WorkflowDefinition in every one; any other id is a 404.',
    type: [String],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayMaxSize(50)
  @IsString({ each: true })
  targetTenantIds: string[];

  @ApiPropertyOptional({
    description:
      'Which immutable version to sync. Defaults to the source tenant’s ACTIVE PUBLISHED version — never simply the newest, which may be an unfinished draft.',
    minimum: 1,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  versionNumber?: number;

  @ApiPropertyOptional({ description: 'Free-text note recorded on each target’s creation event.', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  changeReason?: string;
}

export class WorkflowSyncTargetResponse {
  @ApiProperty({ description: 'The tenant this row reports on.' })
  tenantId: string;

  @ApiProperty({ description: 'The DRAFT definition row written in that tenant.' })
  workflowDefinitionId: string;

  @ApiProperty({ description: 'The lineage slug in that tenant.' })
  slug: string;

  @ApiProperty({ description: 'The version number minted in that tenant’s lineage.' })
  versionNumber: number;

  @ApiProperty({
    description:
      'Findings from recompiling the graph against THAT tenant’s catalogue and invariant rules. Non-blocking findings are ' +
      'reported here rather than swallowed — the graph is the source tenant’s, and a rule the target adds is exactly what an ' +
      'admin needs to see.',
    type: [String],
  })
  findings: string[];
}

export class WorkflowSyncResponse {
  @ApiProperty({ description: 'The source lineage slug.' })
  slug: string;

  @ApiProperty({ description: 'The exact immutable source version that was synced.' })
  sourceVersionNumber: number;

  @ApiProperty({ description: 'One row per target tenant, in the order requested.', type: [WorkflowSyncTargetResponse] })
  targets: WorkflowSyncTargetResponse[];
}
