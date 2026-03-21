import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsArray, IsEnum, IsNumber, Matches, MaxLength, MinLength, Min } from 'class-validator';
import { ModelCategory, ModelTaskType, ModelType, AiModelSource, AiModelFormat } from '@arcaai/domains';

export class CreateModelRequest {
    @ApiProperty({
        description: 'Model name',
        example: 'Whisper Large V3'
    })
    @IsString()
    @IsNotEmpty()
    @MaxLength(255)
    name: string;

    @ApiProperty({
        description: 'URL-friendly unique identifier',
        example: 'whisper-large-v3'
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
        description: 'Model description',
        example: 'OpenAI Whisper Large V3 for high-accuracy speech recognition'
    })
    @IsString()
    @IsOptional()
    @MaxLength(1000)
    description?: string;

    @ApiProperty({
        description: 'Model category',
        enum: ModelCategory,
        example: ModelCategory.AUDIO
    })
    @IsEnum(ModelCategory)
    category: ModelCategory;

    @ApiProperty({
        description: 'Model task type',
        enum: ModelTaskType,
        example: ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION
    })
    @IsEnum(ModelTaskType)
    taskType: ModelTaskType;

    @ApiProperty({
        description: 'Model type',
        enum: ModelType,
        example: ModelType.BASE_MODEL
    })
    @IsEnum(ModelType)
    modelType: ModelType;

    @ApiProperty({
        description: 'Model source',
        enum: AiModelSource,
        example: AiModelSource.HUGGINGFACE
    })
    @IsEnum(AiModelSource)
    source: AiModelSource;

    @ApiProperty({
        description: 'Source URI (HuggingFace repo ID, GitHub URL, MLFlow URI, or local path)',
        example: 'openai/whisper-large-v3'
    })
    @IsString()
    @IsNotEmpty()
    @MaxLength(500)
    sourceUri: string;

    @ApiPropertyOptional({
        description: 'Source revision (git commit, tag, or MLFlow version)',
        example: 'main'
    })
    @IsString()
    @IsOptional()
    @MaxLength(100)
    sourceRevision?: string;

    @ApiProperty({
        description: 'Model format',
        enum: AiModelFormat,
        example: AiModelFormat.SAFETENSOR
    })
    @IsEnum(AiModelFormat)
    format: AiModelFormat;

    @ApiPropertyOptional({
        description: 'Estimated memory size in MB',
        example: 4096
    })
    @IsNumber()
    @IsOptional()
    @Min(1)
    memorySizeMb?: number;

    @ApiPropertyOptional({
        description: 'Compute type (float32, float16, int8)',
        example: 'float16'
    })
    @IsString()
    @IsOptional()
    computeType?: string;

    @ApiPropertyOptional({
        description: 'Tags for categorization',
        example: ['asr', 'multilingual', 'production']
    })
    @IsArray()
    @IsString({ each: true })
    @IsOptional()
    tags?: string[];
}
