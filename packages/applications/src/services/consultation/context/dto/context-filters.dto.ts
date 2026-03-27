import { IsString, IsOptional, IsEnum, IsInt, Min } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { Transform } from 'class-transformer';

export class ContextFiltersDto {
  @ApiPropertyOptional({
    description: 'Filter by context type',
    enum: ['TRANSCRIPT', 'CASE_NOTE', 'RAW_SUMMARY', 'MODIFIED_SUMMARY', 'PRE_SUMMARY', 'NAMED_ENTITY', 'AUDIO_RECORDING', 'WORKNOTE', 'ATTACHMENT'],
  })
  @IsOptional()
  @Transform(({ value }) => (typeof value === 'string' ? value.toUpperCase() : value))
  @IsString()
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
