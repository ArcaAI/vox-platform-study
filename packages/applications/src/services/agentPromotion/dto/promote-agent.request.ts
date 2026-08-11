import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsOptional, IsString, MaxLength, Min } from 'class-validator';

/**
 * TASK-663 — promote one immutable agent configuration version from a source
 * tenant into a target tenant.
 *
 * `fromTenantId` is REQUIRED even though it could be derived by reading
 * `sourceAgentId`. That derivation would force a read BEFORE authorization,
 * and the 403/404 difference between "the source agent does not exist" and
 * "you may not touch that tenant" would then be an existence oracle over
 * another tenant's data. Taking both tenants up front lets the service
 * authorize first and read second.
 */
export class PromoteAgentRequest {
  @ApiProperty({ description: 'The agent to promote, in the SOURCE tenant.' })
  @IsString()
  @IsNotEmpty()
  sourceAgentId!: string;

  @ApiProperty({ description: 'Tenant the agent is promoted FROM. Required so authorization can run before any read.' })
  @IsString()
  @IsNotEmpty()
  fromTenantId!: string;

  @ApiProperty({ description: 'Tenant the agent is promoted INTO.' })
  @IsString()
  @IsNotEmpty()
  toTenantId!: string;

  @ApiPropertyOptional({
    description: 'Which immutable DepartmentAgentVersion to promote. Defaults to the source agent’s latest.',
    minimum: 1,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  agentVersionNumber?: number;

  @ApiPropertyOptional({
    description:
      'Golden set IN THE TARGET TENANT to re-run the eval against. Defaults to the target agent’s own. ' +
      'A source-tenant golden set is never accepted — the corpus never crosses a tenant boundary.',
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
