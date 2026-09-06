import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import {
  AiDeploymentKind,
  AiModelAvailability,
  AiModelFormat,
  AiModelSource,
  AiTaskKind,
  ModelCategory,
  ModelTaskType,
  ModelType,
  ResourceStatusType,
} from '@arcaai/domains';
import { AI_MODEL_LIBRARIES, AI_MODEL_SERVED_BY } from '../constants';

export class ModelResponse {
  @ApiProperty({ description: 'Model ID' })
  id: string;

  @ApiProperty({ description: 'Model name' })
  name: string;

  @ApiProperty({ description: 'URL-friendly unique identifier' })
  slug: string;

  @ApiPropertyOptional({ description: 'Model description' })
  description?: string | null;

  @ApiProperty({ description: 'Model category', enum: ModelCategory })
  category: ModelCategory;

  @ApiProperty({ description: 'Hugging Face task (`pipeline_tag`) as the SCREAMING_CASE enum member.', enum: ModelTaskType })
  taskType: ModelTaskType;

  @ApiProperty({ description: 'The Hugging Face `pipeline_tag` (kebab-case), derived from `taskType`.', example: 'automatic-speech-recognition' })
  pipelineTag: string;

  @ApiProperty({ description: 'Model type', enum: ModelType })
  modelType: ModelType;

  @ApiProperty({
    description: 'Model source. S3 = S3/MinIO-compatible object storage (s3:// only).',
    enum: AiModelSource,
  })
  source: AiModelSource;

  @ApiProperty({
    description: 'Source URI. Scheme grammar: `hf:<org>/<repo>` or a bare HuggingFace id · `file:///abs/path` · `s3://bucket/prefix`.',
  })
  sourceUri: string;

  @ApiPropertyOptional({ description: 'Source revision' })
  sourceRevision?: string | null;

  @ApiProperty({ description: 'Artifact format (descriptive; loader selection is `libraryName`).', enum: AiModelFormat })
  format: AiModelFormat;

  // ── Hugging Face taxonomy + serving identity (TASK-860) ──────────────────

  @ApiProperty({ description: 'Serving library — the Hub `library_name` facet.', enum: AI_MODEL_LIBRARIES })
  libraryName: string;

  @ApiProperty({ description: 'Workload that executes the model.', enum: AI_MODEL_SERVED_BY })
  servedBy: string;

  @ApiProperty({ description: 'SELF_HOSTED or CLOUD.', enum: AiDeploymentKind })
  deploymentKind: AiDeploymentKind;

  @ApiPropertyOptional({ description: 'Vendor wire id for a CLOUD row.', nullable: true })
  wireModelId?: string | null;

  @ApiPropertyOptional({ description: 'Model-card licence identifier.', nullable: true })
  license?: string | null;

  @ApiProperty({ description: 'Hub gated / click-through repo.' })
  gated: boolean;

  @ApiPropertyOptional({ description: 'Upstream base checkpoint.', nullable: true })
  baseModel?: string | null;

  @ApiProperty({ description: 'ISO 639-1 language codes.', type: [String] })
  languages: string[];

  @ApiPropertyOptional({ description: 'Hub commit sha the weights were fetched at.', nullable: true })
  hfRevision?: string | null;

  // ── Bucket identity + measured availability ──────────────────────────────

  @ApiPropertyOptional({ description: 'Key prefix under `s3://hope-models`.', nullable: true })
  bucketPrefix?: string | null;

  @ApiPropertyOptional({ description: 'The single file a single-file loader opens inside `bucketPrefix`.', nullable: true })
  primaryObject?: string | null;

  @ApiPropertyOptional({ description: 'sha256 of the published `manifest.json`.', nullable: true })
  manifestDigest?: string | null;

  @ApiProperty({ description: 'MEASURED presence of the weights in the bucket (inventory job).', enum: AiModelAvailability })
  availability: AiModelAvailability;

  @ApiPropertyOptional({ description: 'When the inventory last measured this row.', nullable: true })
  availabilityCheckedAt?: Date | null;

  @ApiPropertyOptional({ description: 'Per-object verification detail from the last inventory run.', nullable: true })
  availabilityDetail?: unknown;

  @ApiProperty({ description: 'Platform-default election per task.', enum: AiTaskKind, isArray: true })
  isPlatformDefaultFor: AiTaskKind[];

  @ApiPropertyOptional({ description: 'Canonical runtime provider id', nullable: true })
  provider?: string | null;

  @ApiPropertyOptional({ description: 'Model architecture family', nullable: true })
  architecture?: string | null;

  @ApiPropertyOptional({ description: 'Estimated memory size in MB' })
  memorySizeMb?: number | null;

  @ApiPropertyOptional({ description: 'Compute type' })
  computeType?: string | null;

  @ApiPropertyOptional({
    description:
      'DERIVED, never stored (TASK-890 §3.11): `/mnt/models-bucket/` + `bucketPrefix`, plus `primaryObject` for a single-file loader. ' +
      'Read by every service resolver as the highest-precedence weight location; null when the row has no bucket identity, which is ' +
      'the signal to fall back to `sourceUri` scheme dispatch.',
  })
  localPath?: string | null;

  @ApiPropertyOptional({ description: 'SHA256 checksum' })
  checksum?: string | null;

  @ApiProperty({ description: 'Resource status', enum: ResourceStatusType })
  resourceStatus: ResourceStatusType;

  // OCC version surfaced so the global `ETagInterceptor`
  // can stamp `ETag: "<version>"` (the `If-Match` source on PATCH).
  @ApiProperty({ description: 'Optimistic-concurrency row version', example: 7 })
  version: number;

  @ApiProperty({ description: 'Tags', type: [String] })
  tags: string[];

  @ApiProperty({ description: 'Tenant ID (always the SYSTEM tenant for a registry row)' })
  tenantId: string;

  @ApiProperty({ description: 'Created at timestamp' })
  createdAt: Date;

  @ApiProperty({ description: 'Updated at timestamp' })
  updatedAt: Date;

  @ApiPropertyOptional({ description: 'Created by user ID' })
  createdBy?: string | null;

  @ApiPropertyOptional({ description: 'Updated by user ID' })
  updatedBy?: string | null;
}

export class PaginatedModelResponse {
  @ApiProperty({ type: [ModelResponse] })
  data: ModelResponse[];

  @ApiProperty({ description: 'Total number of records' })
  total: number;

  @ApiProperty({ description: 'Current page number' })
  page: number;

  @ApiProperty({ description: 'Number of records per page' })
  limit: number;

  @ApiProperty({ description: 'Total number of pages' })
  totalPages: number;
}
