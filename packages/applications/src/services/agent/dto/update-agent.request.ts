import { ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMaxSize, IsArray, IsInt, IsObject, IsOptional, IsString, MaxLength, Min } from 'class-validator';

/** PATCH is a versioned, OCC-enforced write on a DRAFT/VALIDATED row only (`assertMutable`). */
export class UpdateAgentRequest {
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

  @ApiPropertyOptional({ description: 'Re-bind the backing model (same task).' })
  @IsOptional()
  @IsString()
  @MaxLength(64)
  modelId?: string;

  @ApiPropertyOptional({ description: 'Replaces the whole fallback chain.', type: [String] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(8)
  @IsString({ each: true })
  fallbackModelIds?: string[];

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject()
  instruction?: Record<string, unknown>;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject()
  parameters?: Record<string, unknown>;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject()
  inputSchema?: Record<string, unknown>;

  @ApiPropertyOptional({ type: 'object', additionalProperties: true })
  @IsOptional()
  @IsObject()
  outputSchema?: Record<string, unknown>;

  @ApiPropertyOptional({ type: 'array', items: { type: 'object', additionalProperties: true } })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(32)
  tools?: Array<Record<string, unknown>>;

  @ApiPropertyOptional({ type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];

  @ApiPropertyOptional({ description: 'Optimistic-concurrency version; the `If-Match` header overrides it when both are present.' })
  @IsOptional()
  @IsInt()
  @Min(1)
  expectedVersion?: number;
}
