import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsArray, Matches, MaxLength, MinLength } from 'class-validator';

export class CreatePipelineRequest {
    @ApiProperty({
        description: 'Pipeline name',
        example: 'Whisper Large V3 Medical'
    })
    @IsString()
    @IsNotEmpty()
    @MaxLength(255)
    name: string;

    @ApiProperty({
        description: 'URL-friendly unique identifier',
        example: 'whisper-large-v3-medical'
    })
    @IsString()
    @IsNotEmpty()
    @MinLength(2)
    @MaxLength(100)
    @Matches(/^[a-z0-9][a-z0-9-]*[a-z0-9]$|^[a-z0-9]$/, {
        message: 'Slug must be lowercase alphanumeric with hyphens'
    })
    slug: string;

    @ApiPropertyOptional({
        description: 'Pipeline description',
        example: 'Optimized pipeline for medical transcription with VAD and noise reduction'
    })
    @IsString()
    @IsOptional()
    @MaxLength(1000)
    description?: string;

    @ApiProperty({
        description: 'Pipeline configuration in YAML format',
        example: `version: "1.0"
models:
  asr: "whisper-large-v3"
  vad: "silero-vad-v4"
preprocessing:
  vad:
    enabled: true
    threshold: 0.5
inference:
  batch_size: 16
  compute_type: float16`
    })
    @IsString()
    @IsNotEmpty()
    configYaml: string;

    @ApiPropertyOptional({
        description: 'Tags for categorization',
        example: ['medical', 'high-accuracy', 'production']
    })
    @IsArray()
    @IsString({ each: true })
    @IsOptional()
    tags?: string[];
}
