import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsArray, IsEnum, IsNumber, Matches, MaxLength, MinLength, Min } from 'class-validator';
import { ModelCategory, ModelTaskType, ModelType, AiModelSource, AiModelFormat } from '@arcaai/domains';

export class UpdateModelRequest {
  @ApiPropertyOptional({
    description: 'Model name',
    example: 'Whisper Large V3 Updated',
  })
  @IsString()
  @IsOptional()
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional({
    description: 'URL-friendly unique identifier',
    example: 'whisper-large-v3',
  })
  @IsString()
  @IsOptional()
  @MinLength(2)
  @MaxLength(100)
  @Matches(/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/, {
    message: 'Slug must be lowercase alphanumeric with hyphens',
  })
  slug?: string;

  @ApiPropertyOptional({
    description: 'Model description',
  })
  @IsString()
  @IsOptional()
  @MaxLength(1000)
  description?: string;

  @ApiPropertyOptional({
    description: 'Model category',
    enum: ModelCategory,
  })
  @IsEnum(ModelCategory)
  @IsOptional()
  category?: ModelCategory;

  @ApiPropertyOptional({
    description: 'Model task type',
    enum: ModelTaskType,
  })
  @IsEnum(ModelTaskType)
  @IsOptional()
  taskType?: ModelTaskType;

  @ApiPropertyOptional({
    description: 'Model type',
    enum: ModelType,
  })
  @IsEnum(ModelType)
  @IsOptional()
  modelType?: ModelType;

  @ApiPropertyOptional({
    description: 'Model source',
    enum: AiModelSource,
  })
  @IsEnum(AiModelSource)
  @IsOptional()
  source?: AiModelSource;

  @ApiPropertyOptional({
    description: 'Source URI',
  })
  @IsString()
  @IsOptional()
  @MaxLength(500)
  sourceUri?: string;

  @ApiPropertyOptional({
    description: 'Source revision',
  })
  @IsString()
  @IsOptional()
  @MaxLength(100)
  sourceRevision?: string;

  @ApiPropertyOptional({
    description: 'Model format',
    enum: AiModelFormat,
  })
  @IsEnum(AiModelFormat)
  @IsOptional()
  format?: AiModelFormat;

  @ApiPropertyOptional({
    description: 'Estimated memory size in MB',
  })
  @IsNumber()
  @IsOptional()
  @Min(1)
  memorySizeMb?: number;

  @ApiPropertyOptional({
    description: 'Compute type',
  })
  @IsString()
  @IsOptional()
  computeType?: string;

  @ApiPropertyOptional({
    description: 'Tags for categorization',
  })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  tags?: string[];
}
