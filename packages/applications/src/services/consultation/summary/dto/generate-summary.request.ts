import { IsString, IsOptional, IsBoolean, IsObject, IsArray } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';

export class GenerateSummaryRequest {
  @ApiPropertyOptional({ description: 'Transcription text (if not provided, uses existing transcriptions)' })
  @IsOptional()
  @IsString()
  transcription?: string;

  @ApiPropertyOptional({ description: 'DNA Style ID for summarization' })
  @IsOptional()
  @IsString()
  dnaStyleId?: string;

  @ApiPropertyOptional({ description: 'Template to use for summarization' })
  @IsOptional()
  @IsString()
  template?: string;

  @ApiPropertyOptional({ description: 'Include Named Entity Recognition' })
  @IsOptional()
  @IsBoolean()
  includeNER?: boolean;

  @ApiPropertyOptional({ description: 'Specific context item IDs to use for summarization' })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  contextItemIds?: string[];

  @ApiPropertyOptional({ description: 'Additional options for summarization' })
  @IsOptional()
  @IsObject()
  options?: Record<string, unknown>;
}
