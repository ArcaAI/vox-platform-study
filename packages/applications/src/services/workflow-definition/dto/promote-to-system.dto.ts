import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsOptional, IsString, MaxLength, Min } from 'class-validator';

/**
 * TASK-885 (owner #4) — "the platform admin builds in Global (`50000000-…`) and promotes into
 * SYSTEM (`00000000-…`); SYSTEM is the template every customer tenant refers to and the tenant
 * template for new tenants; only the platform admin manages SYSTEM".
 *
 * The route is that ONE path, so neither tenant is a field. `fromTenantId` is the Global
 * playground and `toTenantId` is SYSTEM, both fixed by the service — an arbitrary
 * tenant → tenant push already exists at `POST admin/agent-promotions`, and offering a second,
 * looser way to write into SYSTEM would be a way to write into SYSTEM from somewhere the owner
 * did not name.
 */
export class PromoteWorkflowToSystemRequest {
  @ApiProperty({ description: 'The workflow to promote, by slug, in the Global build tenant.' })
  @IsString()
  @IsNotEmpty()
  sourceDefinitionSlug: string;

  @ApiPropertyOptional({
    description: 'Which immutable Global version to promote. Defaults to Global’s ACTIVE PUBLISHED version.',
    minimum: 1,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  definitionVersionNumber?: number;

  @ApiPropertyOptional({ description: 'Free-text note recorded on the promotion record.', maxLength: 500 })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  changeReason?: string;
}

export class PromoteWorkflowToSystemResponse {
  @ApiProperty({ description: 'The immutable promotion record id (the WORM audit row in SYSTEM).' })
  promotionId: string;

  @ApiProperty({ description: 'The SYSTEM WorkflowDefinition row this promotion created and published.' })
  workflowDefinitionId: string;

  @ApiProperty({ description: 'The template lineage slug in SYSTEM.' })
  slug: string;

  @ApiProperty({ description: 'The version number minted in SYSTEM’s lineage. The previous version stays as history.' })
  versionNumber: number;

  @ApiProperty({ description: 'True once the SYSTEM row is PUBLISHED and active — i.e. it is now the platform template.' })
  published: boolean;

  @ApiProperty({
    description:
      'The eval promotion gate’s verdict on this path. `warn` is the default here (owner #7): the Global → SYSTEM path must ' +
      'not block on evaluation evidence that does not exist yet. A platform admin who writes `agentic.eval.promotionGate` = ' +
      '`block` gets a blocking gate back.',
  })
  evalGateMode: string;

  @ApiProperty({
    description: 'Non-blocking operator alerts — the promotion’s own warnings plus any eval failure recorded in warn mode.',
    type: [String],
  })
  warnings: string[];
}
