import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsEnum, IsObject, IsOptional, IsString, Matches, MaxLength } from 'class-validator';
import { AgentTask } from '@arcaai/domains';
import { WORKFLOW_DEFINITION_SLUG_PATTERN } from '@arcaai/workflow-contract';

/**
 * `tenantId` is NEVER a field here — read from CLS. Server-owned columns
 * (`status`/`isActive`/`versionNumber`/`compiledConfig`/`compiledConfigChecksum`/
 * `validationReport`/`publishedAt`) are declared on NO request DTO: the DTO whitelist is what
 * makes the immutability guard real (the WorkflowDefinition precedent).
 */
export class CreateAgentRequest {
  @ApiProperty({ description: 'Stable lineage key, unique per (tenant, slug, versionNumber).', example: 'clinic-summarizer' })
  @IsString()
  @Matches(WORKFLOW_DEFINITION_SLUG_PATTERN, { message: 'slug must be 2-80 lowercase alphanumerics, - or _, starting and ending alphanumeric' })
  slug!: string;

  @ApiProperty({ description: 'Human-readable name.' })
  @IsString()
  @MaxLength(160)
  name!: string;

  @ApiPropertyOptional({ description: 'Free-text description.' })
  @IsOptional()
  @IsString()
  @MaxLength(2000)
  description?: string;

  @ApiProperty({ description: 'The ONE task this agent performs.', enum: AgentTask, example: AgentTask.TEXT_GENERATION })
  @IsEnum(AgentTask)
  task!: AgentTask;

  @ApiProperty({ description: 'The registry `AiModel` id backing this agent; its `taskType` must match `task`.' })
  @IsString()
  @MaxLength(64)
  modelId!: string;

  @ApiPropertyOptional({ description: 'Ordered fallback model ids of the same task (priority = array position).', type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @IsString({ each: true })
  fallbackModelIds?: string[];

  @ApiPropertyOptional({
    description:
      'Task-specific instruction: `{ promptTemplateId, promptVersionNumber?, variables?, evalGate? }` or `{ systemPrompt }` (TEXT_GENERATION); `{ initialPrompt?, hotwords? }` (SPEECH_TO_TEXT); none (TEXT_TO_SPEECH).',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  instruction?: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'Task-specific hyper-parameters, validated against AGENT_PARAMETER_SCHEMAS[task].',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  parameters?: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'Authorable JSON-Schema subset for the invocation input; defaults per task.',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  inputSchema?: Record<string, unknown>;

  @ApiPropertyOptional({
    description: 'Authorable JSON-Schema subset for the invocation output; defaults per task.',
    type: 'object',
    additionalProperties: true,
  })
  @IsOptional()
  @IsObject()
  outputSchema?: Record<string, unknown>;

  @ApiPropertyOptional({
    description: '`[{ mcpServerId, toolName }]` — TEXT_GENERATION only.',
    type: 'array',
    items: { type: 'object', additionalProperties: true },
  })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(32)
  tools?: Array<Record<string, unknown>>;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];
}
