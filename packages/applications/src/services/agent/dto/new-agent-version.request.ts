import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { WORKFLOW_DEFINITION_SLUG_PATTERN } from '@arcaai/workflow-contract';

/**
 * Branch a new DRAFT from ANY version (the caller's own — same lineage, `max + 1`) or from a
 * SYSTEM platform agent (a NEW lineage in the caller's tenant, `slug` defaulting to the source's).
 */
export class NewAgentVersionRequest {
  @ApiPropertyOptional({ description: 'Only when branching from a SYSTEM agent: the slug of the new tenant lineage (defaults to the source slug).' })
  @IsOptional()
  @IsString()
  @Matches(WORKFLOW_DEFINITION_SLUG_PATTERN, { message: 'slug must be 2-80 lowercase alphanumerics, - or _, starting and ending alphanumeric' })
  slug?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(160)
  name?: string;

  @ApiPropertyOptional()
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;
}
