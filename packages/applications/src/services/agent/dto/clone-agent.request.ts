import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsInt, IsOptional, IsString, Matches, MaxLength, Min } from 'class-validator';
import { WORKFLOW_DEFINITION_SLUG_PATTERN } from '@arcaai/workflow-contract';

/**
 * Clone an agent into a NEW lineage (TASK-884, owner decision #2: "an agent can be cloned from
 * a SYSTEM template or from any existing agent visible to the tenant").
 *
 * `newSlug` is REQUIRED and must differ from the source's when the source is the caller's own
 * lineage — a clone that kept the slug would be a new VERSION, which is what `POST :id/versions`
 * already is. `tenantId` is the SUPER-ADMIN-only escape hatch for cloning into another tenant;
 * a tenant admin never supplies it and gets its own tenant.
 */
export class CloneAgentRequest {
  @ApiProperty({ description: 'The slug of the new lineage the clone starts.', example: 'clinic-summarizer-rheum' })
  @IsString()
  @Matches(WORKFLOW_DEFINITION_SLUG_PATTERN, { message: 'newSlug must be 2-80 lowercase alphanumerics, - or _, starting and ending alphanumeric' })
  newSlug!: string;

  @ApiPropertyOptional({ description: 'Name for the clone; defaults to the source’s name with a “(copy)” suffix.' })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  name?: string;

  @ApiPropertyOptional({ description: 'Description for the clone; defaults to the source’s.' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiPropertyOptional({ description: 'Clone this exact source version rather than the ACTIVE PUBLISHED one.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  sourceVersionNumber?: number;

  @ApiPropertyOptional({
    description:
      'SUPER_ADMIN only: land the clone in this tenant instead of the caller’s working tenant. A tenant admin that supplies it is refused 403.',
  })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  tenantId?: string;

  @ApiPropertyOptional({ description: 'Replace the source’s tags. `key:value` pairs; a bare key is refused.', type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(24)
  @IsString({ each: true })
  tags?: string[];
}
