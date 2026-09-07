import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsEnum, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { PipelinePolicyScope } from '@arcaai/domains';

export class UpsertWorkflowAssignmentRequest {
  @ApiProperty({
    description: 'Cascade tier this assignment sits on. Only TENANT and DEPARTMENT are accepted — a per-doctor workflow is out of scope.',
    enum: PipelinePolicyScope,
    example: PipelinePolicyScope.DEPARTMENT,
  })
  @IsEnum(PipelinePolicyScope)
  scope!: PipelinePolicyScope;

  @ApiPropertyOptional({ description: 'The department id for a DEPARTMENT-scope assignment; omitted (or null) for TENANT scope.' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  scopeId?: string | null;

  @ApiProperty({
    description: 'Registered palette this assignment governs (validated against the code-owned node registry).',
    example: 'summarization',
  })
  @IsString()
  @MaxLength(64)
  paletteKey!: string;

  @ApiProperty({
    description: 'Lineage slug of the assigned definition. Must resolve to a PUBLISHED definition on this palette in the caller tenant.',
    example: 'radiology-note',
  })
  @IsString()
  @MaxLength(128)
  workflowDefinitionSlug!: string;

  @ApiPropertyOptional({
    description:
      'TASK-891 — the optional `key:value` tag selector this assignment is qualified by, e.g. `["visit-type:revisit"]`. ' +
      'A tier may hold one row per selector plus one unqualified row; resolution tries the most specific MATCHING selector ' +
      'first and the unqualified row last. Omitted (or empty) = the tier’s unqualified assignment. A bare key is refused. ' +
      'The selector identifies the row: changing it addresses a DIFFERENT assignment, it does not re-tag this one.',
    type: [String],
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(24)
  @IsString({ each: true })
  selectorTags?: string[];

  @ApiPropertyOptional({ description: 'Why the assignment changed — recorded verbatim on the WORM change row.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @ApiPropertyOptional({ description: 'OCC token; the `If-Match` header wins when both are supplied.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  expectedVersion?: number;
}
