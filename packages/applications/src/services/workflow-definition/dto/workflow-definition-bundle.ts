import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsInt, IsNotEmpty, IsObject, IsOptional, IsString, Matches, MaxLength, Min, ValidateNested } from 'class-validator';
import { Type } from 'class-transformer';
import { WORKFLOW_DEFINITION_SLUG_PATTERN } from '@arcaai/workflow-contract';
import type { PortableReference } from '../portable-graph';
import type { PortableBundle, PortableSourceTenantKind } from '../portable-bundle.contract';

/**
 * TASK-885 (owner #4) — the JSON a tenant admin exports and imports.
 *
 * ## What travels
 *
 * VALUES ONLY: the authored definition (name, description, palette), its graph with every node
 * config, and the manifest of the portable keys that graph references. What does NOT travel is
 * as much of the contract as what does:
 *
 * | Never exported | Why |
 * |---|---|
 * | `compiledConfig`, `compiledConfigChecksum`, `registryChecksum`, `validationReport` | DERIVED. They are output of the importing tenant's own registry and rule set, and a carried-over report is a stale claim about a graph that now lives somewhere else — the reasoning `clone()` already applies |
 * | any row id | see `portable-graph.ts` |
 * | any credential | nothing in a graph holds one; provider credentials live on `AiProviderConnection`, which a workflow only ever names through a task key |
 * | `evalGate` / `goldenSetId` | a corpus of Vault-Transit-encrypted PHI |
 * | `tenantId`, `status`, `isActive`, `publishedAt`, `tags` | server-owned; an import lands DRAFT and inactive, never publishable by assertion |
 */
export class WorkflowDefinitionBundlePayload {
  @ApiProperty({ description: 'Human-readable name of the exported definition.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(160)
  name: string;

  @ApiPropertyOptional({ description: 'Free-text description.', nullable: true })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string | null;

  @ApiProperty({ description: 'The palette the definition targets. Must be a palette the importing deployment’s node registry declares.' })
  @IsString()
  @IsNotEmpty()
  @MaxLength(80)
  paletteKey: string;

  @ApiProperty({ description: 'The authored graph, with every row id replaced by a portable key.', type: Object })
  @IsObject()
  graph: Record<string, unknown>;

  @ApiProperty({
    description:
      'Every portable reference the graph makes — prompt templates by name, document templates and agents by slug, ' +
      'models by slug, routing by task key. An import resolves each against the caller’s visible catalogue and refuses ' +
      'the whole bundle, naming them, if any cannot be resolved.',
    type: Object,
    isArray: true,
  })
  @IsArray()
  references: PortableReference[];
}

export class WorkflowDefinitionBundleSource {
  @ApiProperty({ description: 'Which tier authored the export: the platform template library, the platform build tenant, or a customer tenant.' })
  @IsString()
  @IsNotEmpty()
  tenantKind: PortableSourceTenantKind;

  @ApiProperty({ description: 'The exported definition’s slug.' })
  @IsString()
  @IsNotEmpty()
  slug: string;

  @ApiProperty({ description: 'The exact version row exported.' })
  @IsInt()
  @Min(1)
  versionNumber: number;
}

/** The envelope. See `portable-bundle.contract.ts` — lane F owns the shared shape. */
export class WorkflowDefinitionBundle implements PortableBundle<'workflow-definition', WorkflowDefinitionBundlePayload> {
  @ApiProperty({ description: 'Always `workflow-definition`.', example: 'workflow-definition' })
  @IsString()
  @IsNotEmpty()
  kind: 'workflow-definition';

  @ApiProperty({ description: 'Payload shape version. An import refuses a version it does not implement.', example: 1 })
  @IsInt()
  @Min(1)
  schemaVersion: number;

  @ApiProperty({ description: 'ISO-8601 instant the export was taken.' })
  @IsString()
  @IsNotEmpty()
  exportedAt: string;

  @ApiProperty({ type: WorkflowDefinitionBundleSource })
  @ValidateNested()
  @Type(() => WorkflowDefinitionBundleSource)
  source: WorkflowDefinitionBundleSource;

  @ApiProperty({ type: WorkflowDefinitionBundlePayload })
  @ValidateNested()
  @Type(() => WorkflowDefinitionBundlePayload)
  payload: WorkflowDefinitionBundlePayload;
}

/**
 * Import one bundle into the caller's tenant as a NEW lineage.
 *
 * `targetSlug` is required for exactly the reason `CloneWorkflowDefinitionRequest.targetSlug` is:
 * the slug is the workflow's PUBLIC address, and the bundle's own slug may already be in use here
 * (or may be another deployment's naming convention entirely).
 */
export class ImportWorkflowDefinitionRequest {
  @ApiProperty({
    description: 'Slug for the NEW lineage in the caller’s tenant. A slug already in use is rejected 409, never silently versioned.',
    example: 'discharge_summary_imported',
  })
  @IsString()
  @Matches(WORKFLOW_DEFINITION_SLUG_PATTERN, { message: 'targetSlug must be 2-80 lowercase alphanumerics, - or _, starting and ending alphanumeric' })
  targetSlug: string;

  @ApiPropertyOptional({ description: 'Override the bundle’s name. Defaults to the exported name.' })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  name?: string;

  @ApiProperty({ type: WorkflowDefinitionBundle, description: 'The exported bundle, verbatim.' })
  @ValidateNested()
  @Type(() => WorkflowDefinitionBundle)
  bundle: WorkflowDefinitionBundle;
}
