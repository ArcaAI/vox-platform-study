import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsOptional, IsString, MaxLength, Min } from 'class-validator';

/**
 * Promote one immutable workflow-definition version from a source tenant into a
 * target tenant.
 *
 * `fromTenantId` is REQUIRED even though a slug could be resolved without it.
 * Deriving it would force a read BEFORE authorization, and the 403/404
 * difference between "that workflow does not exist" and "you may not touch that
 * tenant" would then be an existence oracle over another tenant's data. Taking
 * both tenants up front lets the service authorize first and read second.
 *
 * TASK-815 renamed every field of this request: the promotable moved from a
 * `DepartmentAgentVersion` to a `WorkflowDefinition` version, and a request
 * whose fields still said "agent" would describe something that no longer
 * exists.
 */
export class PromoteWorkflowRequest {
  @ApiProperty({ description: 'The workflow definition to promote, by slug, in the SOURCE tenant.' })
  @IsString()
  @IsNotEmpty()
  sourceDefinitionSlug!: string;

  @ApiProperty({ description: 'Tenant the workflow is promoted FROM. Required so authorization can run before any read.' })
  @IsString()
  @IsNotEmpty()
  fromTenantId!: string;

  @ApiProperty({ description: 'Tenant the workflow is promoted INTO.' })
  @IsString()
  @IsNotEmpty()
  toTenantId!: string;

  @ApiPropertyOptional({
    description:
      'Which immutable version to promote. Defaults to the source tenant’s ACTIVE PUBLISHED version — never simply the newest, ' +
      'which may be an unfinished draft. Name a number to promote a draft deliberately.',
    minimum: 1,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  definitionVersionNumber?: number;

  @ApiPropertyOptional({
    description:
      'Golden set IN THE TARGET TENANT to run the eval against. A source-tenant golden set is never accepted — the corpus never ' +
      'crosses a tenant boundary, which is also why the promoted graph’s own `evalGate` bindings are stripped.',
  })
  @IsOptional()
  @IsString()
  targetGoldenSetId?: string;

  @ApiPropertyOptional({
    description:
      'An EvalRun in the SOURCE tenant travelling as an attestation. Recorded as evidence only — ' +
      'it is never treated as a result the target inherits; the target re-runs its own.',
  })
  @IsOptional()
  @IsString()
  sourceEvalRunId?: string;

  @ApiPropertyOptional({ description: 'Free-text note recorded on the promotion record.', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  changeReason?: string;
}
