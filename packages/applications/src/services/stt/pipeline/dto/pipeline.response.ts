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
    description:
      'Row version for optimistic concurrency control. Echo back as `If-Match: "<version>"` or `expectedVersion` on PATCH.',
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
