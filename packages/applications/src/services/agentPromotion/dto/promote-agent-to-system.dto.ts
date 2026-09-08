import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsInt, IsNotEmpty, IsOptional, IsString, MaxLength, Min } from 'class-validator';

/**
 * TASK-930 §6.1 — the AGENT half of the promotion process owner decision #4 describes:
 * *the platform admin builds in Global (`50000000-…`) and promotes into SYSTEM (`00000000-…`);
 * SYSTEM is the reference set every customer tenant is provisioned from; only the platform admin
 * manages SYSTEM.*
 *
 * A deliberate mirror of `PromoteWorkflowToSystemRequest`, and for the same reason it takes no
 * tenant: the route IS the one path. `fromTenantId` is the Global playground and `toTenantId` is
 * SYSTEM, both fixed by the service — an arbitrary tenant → tenant push of an AGENT already
 * exists (`POST admin/agents/{slug}/sync`, `POST admin/agents/{slug}/clone`), and offering a
 * second, looser way to write into SYSTEM would be a way to write into SYSTEM from somewhere the
 * owner did not name.
 *
 * `changeReason` is REQUIRED here where the workflow request leaves it optional. A SYSTEM agent
 * is what every tenant provisioned after this call inherits, so "why did the platform default
 * change?" must be answerable from the WORM record alone.
 */
export class PromoteAgentToSystemRequest {
  @ApiProperty({ description: 'The agent to promote, by slug, in the Global build tenant.' })
  @IsString()
  @IsNotEmpty()
  sourceSlug: string;

  @ApiPropertyOptional({
    description: 'Which immutable Global version to promote. Defaults to Global’s ACTIVE PUBLISHED version.',
    minimum: 1,
  })
  @IsOptional()
  @IsInt()
  @Min(1)
  versionNumber?: number;

  @ApiProperty({ description: 'Why this became the platform default. Recorded verbatim on the WORM promotion record.', maxLength: 500 })
  @IsString()
  @IsNotEmpty()
  @MaxLength(500)
  changeReason: string;
}

/** What one promotion copied alongside the agent row itself (TASK-930 §6.1). */
export class PromoteAgentToSystemCopied {
  @ApiProperty({ description: 'Global-owned prompt templates deep-copied into SYSTEM and re-bound on the promoted agent.' })
  promptTemplates: number;

  @ApiProperty({ description: 'Context schemas copied into SYSTEM because SYSTEM carried no schema of that slug.' })
  contextSchemas: number;
}

export class PromoteAgentToSystemResponse {
  @ApiProperty({ description: 'The SYSTEM Agent row this promotion created, published and activated.' })
  agentId: string;

  @ApiProperty({ description: 'The agent lineage slug in SYSTEM — the same slug it carries in Global.' })
  slug: string;

  @ApiProperty({ description: 'The version number minted in SYSTEM’s lineage. The previous version stays as history.' })
  versionNumber: number;

  @ApiProperty({ description: 'The referenced content this promotion had to copy so the SYSTEM row binds nothing it cannot read.' })
  copied: PromoteAgentToSystemCopied;

  @ApiProperty({ description: 'The immutable promotion record id (the WORM audit row in SYSTEM).' })
  promotionId: string;

  @ApiProperty({ description: 'Non-blocking operator alerts raised while copying.', type: [String] })
  warnings: string[];
}
