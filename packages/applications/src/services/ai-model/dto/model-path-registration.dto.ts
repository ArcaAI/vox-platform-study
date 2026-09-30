import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsEnum, IsIn, IsNotEmpty, IsOptional, IsString, Matches, MaxLength, MinLength } from 'class-validator';
import type { LocalModelPreview, RegisterFromPathRequest as RegisterFromPathContract } from '@arcaai/types';
import { AiModelFormat, ModelTaskType } from '@arcaai/domains';
import { AI_MODEL_LIBRARIES, AI_MODEL_SERVED_BY, HOPE_MODELS_MOUNT } from '../constants';

const PATH_DESCRIPTION =
  `A folder or file in the models bucket. Accepted as the mount path (\`${HOPE_MODELS_MOUNT}/<prefix>\`), bucket-qualified ` +
  '(`hope-models/<prefix>`), as an S3 URI (`s3://hope-models/<prefix>`) or bare (`<prefix>`). A file path registers its folder, ' +
  'with the file as the primary object.';

// ─── GET admin/ai-models/local/preview ───────────────────────────────────────

export class LocalModelPreviewQuery {
  @ApiProperty({ description: PATH_DESCRIPTION, example: `${HOPE_MODELS_MOUNT}/whisper-ml/` })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1024)
  path: string;
}

export class LocalModelFileResponse {
  @ApiProperty({ description: 'Object key, relative to `bucketPrefix`.', example: 'ggml-large-v3-q5_0.bin' }) key: string;
  @ApiProperty({ description: 'Size in bytes.' }) size: number;
}

export class LocalModelSuggestionResponse {
  @ApiProperty({ description: 'Registry slug derived from the repo or folder name.', example: 'whisper-ml' }) slug: string;
  @ApiProperty({ description: 'Display name (the repo or folder name).' }) name: string;
  @ApiProperty({ enum: ModelTaskType, nullable: true, type: String }) taskType: string | null;
  @ApiProperty({ enum: AI_MODEL_LIBRARIES, nullable: true, type: String }) libraryName: string | null;
  @ApiProperty({ enum: AiModelFormat, nullable: true, type: String }) format: string | null;
  @ApiProperty({ enum: AI_MODEL_SERVED_BY, nullable: true, type: String }) servedBy: string | null;
  @ApiProperty({ description: '`config.json` `architectures[0]`.', nullable: true, type: String }) architecture: string | null;
  @ApiProperty({ description: '`config.json` `torch_dtype`.', nullable: true, type: String }) computeType: string | null;
}

export class LocalModelPreviewResponse implements LocalModelPreview {
  @ApiProperty({ description: 'Bucket-relative prefix, with a trailing slash.', example: 'whisper-ml/' }) bucketPrefix: string;
  @ApiProperty({ description: 'The path every serving pod loads.', example: `${HOPE_MODELS_MOUNT}/whisper-ml/ggml-large-v3-q5_0.bin` })
  localPath: string;
  @ApiProperty({
    description: 'The single file a single-file loader opens, relative to `bucketPrefix`; null otherwise.',
    nullable: true,
    type: String,
  })
  primaryObject: string | null;
  @ApiProperty({
    description: '`hf-cache` (a Hugging Face cache snapshot), `flat` (a published `<slug>/<version>/` with a manifest) or `files`.',
    enum: ['hf-cache', 'flat', 'files'],
  })
  layout: 'hf-cache' | 'flat' | 'files';
  @ApiProperty({ type: [LocalModelFileResponse] }) files: LocalModelFileResponse[];
  @ApiProperty({ description: 'Sum of every object size, in bytes.' }) totalBytes: number;
  @ApiProperty({ description: 'The snapshot commit sha, for an HF cache snapshot.', nullable: true, type: String }) revision: string | null;
  @ApiProperty({ description: 'Registry fields derived from the objects; null where nothing could be inferred.', type: LocalModelSuggestionResponse })
  suggested: LocalModelSuggestionResponse;
}

// ─── POST admin/ai-models/register-from-path ─────────────────────────────────

/** Register weights already in the models bucket. Every field but `path` overrides what the preview derives. */
export class RegisterFromPathRequest implements RegisterFromPathContract {
  @ApiProperty({ description: PATH_DESCRIPTION, example: `${HOPE_MODELS_MOUNT}/whisper-ml/` })
  @IsString()
  @IsNotEmpty()
  @MaxLength(1024)
  path: string;

  @ApiPropertyOptional({ description: 'Registry slug. Defaults to the repo or folder name in slug form.', example: 'whisper-ml' })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  @Matches(/^[a-z0-9]+(?:[-_][a-z0-9]+)*$/, {
    message: 'Slug must be lowercase alphanumeric with hyphens (an underscore may join segments, e.g. q8_0)',
  })
  slug?: string;

  @ApiPropertyOptional({ description: 'Display name. Defaults to the repo or folder name.' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional({ enum: ModelTaskType })
  @IsOptional()
  @IsEnum(ModelTaskType)
  taskType?: ModelTaskType;

  @ApiPropertyOptional({ enum: AI_MODEL_LIBRARIES })
  @IsOptional()
  @IsIn(AI_MODEL_LIBRARIES)
  libraryName?: string;

  @ApiPropertyOptional({ enum: AiModelFormat })
  @IsOptional()
  @IsEnum(AiModelFormat)
  format?: AiModelFormat;

  @ApiPropertyOptional({ enum: AI_MODEL_SERVED_BY })
  @IsOptional()
  @IsIn(AI_MODEL_SERVED_BY)
  servedBy?: string;
}
