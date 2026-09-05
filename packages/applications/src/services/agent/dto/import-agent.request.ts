import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsNotEmptyObject, IsObject, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { WORKFLOW_DEFINITION_SLUG_PATTERN } from '@arcaai/workflow-contract';

/**
 * Import an exported agent bundle into the caller's tenant as a DRAFT (TASK-884, owner #4).
 *
 * The bundle is validated as an ENVELOPE first (kind / schemaVersion / source), then as an agent
 * PAYLOAD, and only then are its `modelSlug`, prompt-template ref and tool bindings re-resolved
 * against what the CALLER's tenant can actually see. Anything that cannot be resolved is a 409
 * naming it — never a silently dropped binding.
 */
export class ImportAgentRequest {
  @ApiProperty({
    description: 'The exported bundle, exactly as `GET /admin/agents/{slug}/export` produced it.',
    type: 'object',
    additionalProperties: true,
  })
  @IsObject()
  @IsNotEmptyObject()
  bundle!: Record<string, unknown>;

  @ApiPropertyOptional({ description: 'Land the import under this slug instead of the bundle’s (e.g. when the bundle’s slug is already taken).' })
  @IsOptional()
  @IsString()
  @Matches(WORKFLOW_DEFINITION_SLUG_PATTERN, { message: 'slug must be 2-80 lowercase alphanumerics, - or _, starting and ending alphanumeric' })
  slug?: string;

  @ApiPropertyOptional({ description: 'Override the imported agent’s name.' })
  @IsOptional()
  @IsString()
  @MaxLength(160)
  name?: string;
}
