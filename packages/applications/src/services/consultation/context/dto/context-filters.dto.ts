import { IsOptional, IsEnum, IsInt, IsIn, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';

const VALID_CONTEXT_TYPES = [
  'TRANSCRIPT',
  'CASE_NOTE',
  'RAW_SUMMARY',
  'MODIFIED_SUMMARY',
  'PRE_SUMMARY',
  'NAMED_ENTITY',
  'AUDIO_RECORDING',
  'WORKNOTE',
  'ATTACHMENT',
] as const;

export class ContextFiltersDto {
  @ApiPropertyOptional({
    description: 'Filter by context type',
    enum: VALID_CONTEXT_TYPES,
  })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.toUpperCase() : value))
  @IsIn(VALID_CONTEXT_TYPES, { message: `type must be one of: ${VALID_CONTEXT_TYPES.join(', ')}` })
  type?: string;

  @ApiPropertyOptional({
    description: 'Filter by source',
    enum: ['USER', 'SYSTEM', 'TRANSCRIPTION', 'AI'],
  })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.toUpperCase() : value))
  @IsEnum(['USER', 'SYSTEM', 'TRANSCRIPTION', 'AI'])
  source?: string;

  @ApiPropertyOptional({
    description: 'Page number (1-based)',
    example: 1,
    default: 1,
  })
  @IsOptional()
  @Transform(({ value }) => parseInt(value, 10))
  @IsInt()
  @Min(1)
  page?: number;

  @ApiPropertyOptional({
    description: 'Number of items per page',
    example: 50,
    default: 50,
  })
  @IsOptional()
  @Transform(({ value }) => parseInt(value, 10))
  @IsInt()
  @Min(1)
  limit?: number;
}
