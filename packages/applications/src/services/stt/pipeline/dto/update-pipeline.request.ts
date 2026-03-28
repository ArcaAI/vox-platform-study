import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsOptional, IsArray, Matches, MaxLength, MinLength } from 'class-validator';

export class UpdatePipelineRequest {
  @ApiPropertyOptional({
    description: 'Pipeline name',
    example: 'Whisper Large V3 Medical Updated',
  })
  @IsString()
  @IsOptional()
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional({
    description: 'URL-friendly unique identifier',
    example: 'whisper-large-v3-medical',
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
    description: 'Pipeline description',
    example: 'Updated description for medical transcription pipeline',
  })
  @IsString()
  @IsOptional()
  @MaxLength(1000)
  description?: string;

  @ApiPropertyOptional({
    description: 'Pipeline configuration in YAML format',
  })
  @IsString()
  @IsOptional()
  configYaml?: string;

  @ApiPropertyOptional({
    description: 'Tags for categorization',
    example: ['medical', 'high-accuracy', 'production'],
  })
  @IsArray()
  @IsString({ each: true })
  @IsOptional()
  tags?: string[];
}
