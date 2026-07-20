import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ResourceStatusType } from '@arcaai/domains';

export class PipelineResponse {
  @ApiProperty({ description: 'Pipeline ID' })
  id: string;

  @ApiProperty({ description: 'Pipeline name' })
  name: string;

  @ApiProperty({ description: 'URL-friendly unique identifier' })
  slug: string;

  @ApiPropertyOptional({ description: 'Pipeline description' })
  description?: string | null;

  @ApiProperty({ description: 'Pipeline configuration in YAML format' })
  configYaml: string;

  @ApiProperty({ description: 'Resource status', enum: ResourceStatusType })
  resourceStatus: ResourceStatusType;

  // TASK-328 A6 — whether this pipeline is the tenant's default. Exactly one
  // pipeline per tenant carries `isDefault: true`.
  @ApiProperty({ description: "Whether this pipeline is the tenant's default", example: false })
  isDefault: boolean;

  // TASK-531 — template lineage. `sourceTemplateSlug` is the SYSTEM template
  // this pipeline descends from (null when it is not template-derived);
  // `templateLocked` marks a pristine template copy, which is READ-ONLY for
  // content edits and delete (403 "Template copies are read-only — clone to
  // customize"). Enable/disable and set-default remain available on a locked
  // copy. The console reads these to badge the row and render its detail
  // drawer read-only with a Clone action. Response-only: neither field is
  // accepted on any request DTO.
  @ApiPropertyOptional({
    description: 'Slug of the SYSTEM template this pipeline descends from (null when not template-derived)',
    example: 'production-whisper-large-v3-turbo-gguf',
  })
  sourceTemplateSlug?: string | null;

  @ApiProperty({
    description: 'Whether this is a locked template copy (read-only for content edits and delete; clone to customize)',
    example: false,
  })
  templateLocked: boolean;

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

  // TASK-302 Stream D Phase E.4 — OCC token. Echo via `If-Match: "<n>"`
  // (the `ETagInterceptor` also renders this as `ETag: "<n>"`) or via
  // the body's `expectedVersion` on the next PATCH.
  @ApiProperty({
    description: 'Row version for optimistic concurrency control. Echo back as `If-Match: "<version>"` or `expectedVersion` on PATCH.',
    example: 7,
  })
  version: number;
}

export class PaginatedPipelineResponse {
  @ApiProperty({ type: [PipelineResponse] })
  data: PipelineResponse[];

  @ApiProperty({ description: 'Total number of records' })
  total: number;

  @ApiProperty({ description: 'Current page number' })
  page: number;

  @ApiProperty({ description: 'Number of records per page' })
  limit: number;

  @ApiProperty({ description: 'Total number of pages' })
  totalPages: number;
}
