import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { WORKFLOW_NODE_ID_PATTERN } from '@arcaai/workflow-contract';

/**
 * TASK-856 — seed a NEW workflow from an existing one.
 *
 * `targetSlug` is REQUIRED and caller-supplied rather than derived (`<slug>_copy`): the slug is
 * the workflow's PUBLIC address (`POST /api/v1/workflows/:slug/invoke`, TASK-722), so inventing
 * one for a tenant is a naming decision the platform does not get to make — and `create`
 * already demands an explicit slug, so deriving here would be a second, inconsistent
 * convention. The Studio's clone dialog pre-fills a suggestion client-side.
 *
 * Everything else about the clone is DERIVED, never accepted: the graph, palette and
 * description come from the source row, and the status/version/activation/compile columns are
 * server-owned exactly as they are on `CreateWorkflowDefinitionRequest`. Declaring `graph` here
 * would turn a clone into a create wearing a clone's name — and would let a caller pair one
 * definition's provenance with another definition's bytes.
 *
 * `tenantId` is NEVER a field here: it is read from CLS by the service, and the global pipe's
 * `forbidNonWhitelisted` rejects a forged one.
 */
export class CloneWorkflowDefinitionRequest {
  @ApiProperty({
    description: 'Slug for the NEW lineage. Must be unused by this tenant — a slug already in use is rejected 409, never silently versioned.',
    example: 'discharge_summary_copy',
  })
  @IsString()
  @Matches(WORKFLOW_NODE_ID_PATTERN, { message: 'targetSlug must match [a-z0-9_]{2,48}' })
  targetSlug: string;

  @ApiPropertyOptional({ description: 'Human-readable name for the clone. Defaults to "<source name> (copy)".' })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  name?: string;

  @ApiPropertyOptional({ description: 'Free-text description. Defaults to the source definition’s description.' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;
}
