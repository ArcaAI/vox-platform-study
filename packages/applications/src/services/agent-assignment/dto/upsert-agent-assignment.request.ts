import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsEnum, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';
import { AgentTask, PipelinePolicyScope } from '@arcaai/domains';

export class UpsertAgentAssignmentRequest {
  @ApiProperty({
    description: 'Cascade tier this assignment sits on. Only TENANT and DEPARTMENT are accepted.',
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

  @ApiProperty({ description: 'The agent task this assignment governs.', enum: AgentTask, example: AgentTask.SPEECH_TO_TEXT })
  @IsEnum(AgentTask)
  task!: AgentTask;

  @ApiProperty({
    description: 'Lineage slug of the assigned agent. Must resolve to an ACTIVE PUBLISHED agent of this task visible to the caller tenant.',
    example: 'platform-transcription',
  })
  @IsString()
  @MaxLength(128)
  agentSlug!: string;

  @ApiPropertyOptional({
    description:
      'TASK-884 — the optional `key:value` tag selector this assignment is qualified by, e.g. `["specialty:rheumatology"]`. ' +
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
