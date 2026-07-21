import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ResourceStatusType, ModelCategory, ModelTaskType, ModelType, AiModelSource, AiModelFormat, AiModelDownloadStatus } from '@arcaai/domains';

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

  @ApiProperty({ description: 'Model task type', enum: ModelTaskType })
  taskType: ModelTaskType;

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

  @ApiProperty({ description: 'Model format', enum: AiModelFormat })
  format: AiModelFormat;

  @ApiPropertyOptional({ description: 'Canonical runtime provider id', nullable: true })
  provider?: string | null;

  @ApiPropertyOptional({ description: 'Model architecture family', nullable: true })
  architecture?: string | null;

  @ApiPropertyOptional({ description: 'Estimated memory size in MB' })
  memorySizeMb?: number | null;

  @ApiPropertyOptional({ description: 'Compute type' })
  computeType?: string | null;

  @ApiProperty({ description: 'Download status', enum: AiModelDownloadStatus })
  downloadStatus: AiModelDownloadStatus;

  @ApiPropertyOptional({
    description:
      'Operator/admin weight-directory override — HIGHEST precedence in every service resolver, ahead of ' +
      '`sourceUri` scheme dispatch. Set-but-missing falls through with a warning. Also populated by download bookkeeping.',
  })
  localPath?: string | null;

  @ApiPropertyOptional({ description: 'Download timestamp' })
  downloadedAt?: Date | null;

  @ApiPropertyOptional({ description: 'File size in MB' })
  fileSizeMb?: number | null;

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

  @ApiProperty({ description: 'Tenant ID' })
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
