import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsArray, IsBoolean, IsEnum, IsIn, IsNotEmpty, IsNumber, IsOptional, IsString, Matches, MaxLength, Min, MinLength } from 'class-validator';
import { AiModelFormat, ModelCategory, ModelTaskType, ModelType } from '@arcaai/domains';
import { AI_MODEL_LIBRARIES, AI_MODEL_PROVIDERS, AI_MODEL_SERVED_BY } from '../constants';
import { MODEL_REFERRER_KINDS, type ModelReferrerKind } from '../lifecycle/model-lifecycle.types';
import { ModelResponse } from './model.response';

/** A Hugging Face repo id: `<org>/<name>`, the characters the Hub allows. */
const HF_REPO_ID = /^[\w.-]+\/[\w.-]+$/;
/** A branch, tag or commit — no path traversal, no whitespace. */
const HF_REVISION = /^[\w.-]+$/;

// ─── GET admin/ai-models/hub/preview ─────────────────────────────────────────

export class HubPreviewQuery {
  @ApiProperty({ description: 'Hugging Face repo id, `<org>/<name>`.', example: 'blaze999/Medical-NER' })
  @IsString()
  @Matches(HF_REPO_ID, { message: 'repoId must be a Hugging Face repo id: <org>/<name>' })
  @MaxLength(200)
  repoId: string;

  @ApiPropertyOptional({ description: 'Branch, tag or commit to read. Defaults to `main`.', example: 'main' })
  @IsOptional()
  @IsString()
  @Matches(HF_REVISION, { message: 'revision must be a branch, tag or commit id' })
  @MaxLength(100)
  revision?: string;
}

export class HubFileResponse {
  @ApiProperty({ description: 'Path inside the repo.', example: 'model.safetensors' })
  path: string;

  @ApiProperty({ description: 'Size in bytes.', example: 498_000_000 })
  size: number;
}

export class HubPreviewSuggestionResponse {
  @ApiProperty({ description: 'Category inferred from the task.', enum: ModelCategory, nullable: true })
  category: ModelCategory | null;

  @ApiProperty({ description: 'QUANTIZED_MODEL for GGUF / ggml weights; otherwise not inferred.', enum: ModelType, nullable: true })
  modelType: ModelType | null;

  @ApiProperty({ description: 'Serving library this platform would load it with.', enum: AI_MODEL_LIBRARIES, nullable: true })
  libraryName: string | null;

  @ApiProperty({ description: 'Workload that would run it.', enum: AI_MODEL_SERVED_BY, nullable: true })
  servedBy: string | null;

  @ApiProperty({ description: 'Runtime provider id.', enum: AI_MODEL_PROVIDERS, nullable: true })
  provider: string | null;
}

export class HubPreviewResponse {
  @ApiProperty({ example: 'blaze999/Medical-NER' }) repoId: string;
  @ApiProperty({ description: 'The revision that was read.', example: 'main' }) revision: string;
  @ApiProperty({ description: 'Commit sha the revision resolves to — what will be downloaded.' }) commitSha: string;
  @ApiProperty({ description: 'The registry `sourceUri` this repo registers as.', example: 'hf:blaze999/Medical-NER' }) sourceUri: string;
  @ApiProperty({ description: 'Hub `pipeline_tag`.', nullable: true, type: String }) pipelineTag: string | null;
  @ApiProperty({ description: 'Hub `library_name`, verbatim.', nullable: true, type: String }) libraryName: string | null;
  @ApiProperty({ description: 'Model-card licence.', nullable: true, type: String }) license: string | null;
  @ApiProperty({ description: 'The repo is gated — downloading it needs the platform Hugging Face token.' }) gated: boolean;
  @ApiProperty({ description: 'Model-card languages.', type: [String] }) languages: string[];
  @ApiProperty({ description: 'Upstream base model, when the card names one.', nullable: true, type: String }) baseModel: string | null;
  @ApiProperty({ description: 'Sum of every file size, in bytes.' }) totalBytes: number;
  @ApiProperty({ description: 'Number of files in the repo at this revision.' }) fileCount: number;
  @ApiProperty({ type: [HubFileResponse] }) files: HubFileResponse[];
  @ApiProperty({ description: 'Task inferred from the Hub `pipeline_tag`, as the registry task value.', enum: ModelTaskType, nullable: true })
  taskType: ModelTaskType | null;
  @ApiProperty({ description: 'Registry slug derived from the repo name.', example: 'medical-ner' }) suggestedSlug: string;
  @ApiProperty({ description: 'Display name (the repo name).', example: 'Medical-NER' }) suggestedName: string;
  @ApiProperty({ description: 'Artifact format inferred from the files.', enum: AiModelFormat, nullable: true })
  suggestedFormat: AiModelFormat | null;
  @ApiProperty({
    description: 'How the weights will be laid out in the models bucket: `hf-cache` (a Hugging Face hub cache) or `flat` (`<slug>/<version>/`).',
    enum: ['hf-cache', 'flat'],
  })
  layout: 'hf-cache' | 'flat';
  @ApiProperty({
    description: 'Registry fields prefilled from the card; `null` where nothing could be inferred.',
    type: HubPreviewSuggestionResponse,
  })
  suggested: HubPreviewSuggestionResponse;
}

// ─── POST admin/ai-models/register-from-hub ──────────────────────────────────

/**
 * Register a Hub repo and download it in one call. Every field but `repoId` is
 * an OVERRIDE of what the preview suggests; the resulting row goes through the
 * same validation as `POST admin/ai-models`.
 */
export class RegisterFromHubRequest {
  @ApiProperty({ description: 'Hugging Face repo id, `<org>/<name>`.', example: 'blaze999/Medical-NER' })
  @IsString()
  @Matches(HF_REPO_ID, { message: 'repoId must be a Hugging Face repo id: <org>/<name>' })
  @MaxLength(200)
  repoId: string;

  @ApiPropertyOptional({
    description: 'Branch, tag or commit to register. Defaults to `main`; the row pins the commit it resolves to.',
    example: 'main',
  })
  @IsOptional()
  @IsString()
  @Matches(HF_REVISION, { message: 'revision must be a branch, tag or commit id' })
  @MaxLength(100)
  revision?: string;

  @ApiPropertyOptional({ description: 'Registry slug. Defaults to the repo name in slug form.', example: 'medical-ner' })
  @IsOptional()
  @IsString()
  @MinLength(2)
  @MaxLength(100)
  @Matches(/^[a-z0-9]+(?:[-_.][a-z0-9]+)*$/, {
    message: 'Slug must be lowercase alphanumeric with hyphens (an underscore or a dot may join segments, e.g. q8_0, 4.1)',
  })
  slug?: string;

  @ApiPropertyOptional({ description: 'Display name. Defaults to the repo name.' })
  @IsOptional()
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name?: string;

  @ApiPropertyOptional({ description: 'Description.' })
  @IsOptional()
  @IsString()
  @MaxLength(1000)
  description?: string;

  @ApiPropertyOptional({ enum: ModelCategory })
  @IsOptional()
  @IsEnum(ModelCategory)
  category?: ModelCategory;

  @ApiPropertyOptional({ enum: ModelTaskType })
  @IsOptional()
  @IsEnum(ModelTaskType)
  taskType?: ModelTaskType;

  @ApiPropertyOptional({ enum: ModelType })
  @IsOptional()
  @IsEnum(ModelType)
  modelType?: ModelType;

  @ApiPropertyOptional({ enum: AiModelFormat })
  @IsOptional()
  @IsEnum(AiModelFormat)
  format?: AiModelFormat;

  @ApiPropertyOptional({ enum: AI_MODEL_LIBRARIES })
  @IsOptional()
  @IsIn(AI_MODEL_LIBRARIES)
  libraryName?: string;

  @ApiPropertyOptional({ enum: AI_MODEL_SERVED_BY })
  @IsOptional()
  @IsIn(AI_MODEL_SERVED_BY)
  servedBy?: string;

  @ApiPropertyOptional({ enum: AI_MODEL_PROVIDERS })
  @IsOptional()
  @IsIn(AI_MODEL_PROVIDERS)
  provider?: string;

  @ApiPropertyOptional({ description: 'Model architecture family.' })
  @IsOptional()
  @IsString()
  @MaxLength(100)
  architecture?: string;

  @ApiPropertyOptional({ description: 'Compute type (float32, float16, int8).' })
  @IsOptional()
  @IsString()
  computeType?: string;

  @ApiPropertyOptional({ description: 'Estimated memory size in MB.' })
  @IsOptional()
  @IsNumber()
  @Min(1)
  memorySizeMb?: number;

  @ApiPropertyOptional({ description: 'Tags.', type: [String] })
  @IsOptional()
  @IsArray()
  @IsString({ each: true })
  tags?: string[];
}

export class RegisterFromHubResponse {
  @ApiProperty({ description: 'The registered row (SYSTEM tenant, source HUGGINGFACE, pinned to the resolved commit).', type: ModelResponse })
  model: ModelResponse;

  @ApiProperty({ description: 'The download job — poll `GET admin/ai-models/:id/download`.' })
  jobId: string;
}

// ─── GET admin/ai-models/:id/usage ───────────────────────────────────────────

export class ModelReferrerResponse {
  @ApiProperty({ description: 'What points at the model.', enum: MODEL_REFERRER_KINDS })
  kind: ModelReferrerKind;

  @ApiProperty({ description: 'The tenant that owns the referrer.' })
  tenantId: string;

  @ApiProperty({ description: 'The referrer id (for `agent-fallback`, the agent id).' })
  id: string;

  @ApiProperty({ description: 'Display name, with the version or role where it helps.' })
  name: string;
}

export class ModelUsageResponse {
  @ApiProperty() modelId: string;
  @ApiProperty() slug: string;
  @ApiProperty({ description: 'Whether anything still references the model — an unregister would be refused.' }) inUse: boolean;
  @ApiProperty({ description: 'Every referrer, across all tenants.', type: [ModelReferrerResponse] }) referrers: ModelReferrerResponse[];
}

// ─── POST admin/ai-models/:id/unregister ─────────────────────────────────────

export class UnregisterModelRequest {
  @ApiPropertyOptional({ description: "Delete the model's weights from the models bucket. Defaults to true.", default: true })
  @IsOptional()
  @IsBoolean()
  deleteWeights?: boolean;

  @ApiPropertyOptional({
    description: 'Delete every stored version of the weights now, instead of keeping them recoverable for 30 days. Defaults to false.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  purge?: boolean;
}

export class UnregisterModelResponse {
  @ApiProperty({ description: 'The unregister job id.' })
  jobId: string;

  @ApiProperty({
    description:
      '`deleting` — the weights are being removed; `kept-shared` — another registered model uses the same files, so they stay; `kept` — deletion was not requested or there is nothing in the bucket.',
    enum: ['deleting', 'kept-shared', 'kept'],
  })
  weights: 'deleting' | 'kept-shared' | 'kept';
}

// ─── POST admin/ai-models/download-missing ───────────────────────────────────

export class DownloadMissingEnqueuedResponse {
  @ApiProperty() id: string;
  @ApiProperty() slug: string;
  @ApiProperty() jobId: string;
}

export class DownloadMissingSkippedResponse {
  @ApiProperty() id: string;
  @ApiProperty() slug: string;
  @ApiProperty({
    description:
      '`SOURCE_NOT_FETCHABLE` (no Hub or s3:// source), `DOWNLOADING` (already in progress), `UNREGISTERING`, or `CONFLICT` (changed concurrently).',
    enum: ['SOURCE_NOT_FETCHABLE', 'DOWNLOADING', 'UNREGISTERING', 'CONFLICT'],
  })
  reason: 'SOURCE_NOT_FETCHABLE' | 'DOWNLOADING' | 'UNREGISTERING' | 'CONFLICT';
}

export class DownloadMissingResponse {
  @ApiProperty({ type: [DownloadMissingEnqueuedResponse] }) enqueued: DownloadMissingEnqueuedResponse[];
  @ApiProperty({ type: [DownloadMissingSkippedResponse] }) skipped: DownloadMissingSkippedResponse[];
}
