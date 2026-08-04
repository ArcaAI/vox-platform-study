import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ResourceStatusType } from '@arcaai/domains';

export class TenantAllowedOriginResponse {
  @ApiProperty({ description: 'Row id' })
  id!: string;

  @ApiProperty({ description: 'Owning tenant id. The reserved SYSTEM tenant owns platform-operated origins.' })
  tenantId!: string;

  @ApiProperty({ description: 'True when this row is owned by the reserved SYSTEM tenant (valid for every tenant at the application layer).' })
  isPlatform!: boolean;

  @ApiProperty({ description: 'Normalized origin (scheme://host[:port]).', example: 'https://arcaai-staging.bcmch.org' })
  origin!: string;

  @ApiProperty({ description: 'Human-readable name for the admin list.', example: 'BCMCH pre-production' })
  label!: string;

  @ApiPropertyOptional({ description: 'Optional operator note.' })
  description?: string;

  @ApiPropertyOptional({ description: 'Resource status', enum: ['ENABLED', 'DISABLED'] })
  resourceStatus?: ResourceStatusType;

  @ApiProperty({ description: 'Creation timestamp' })
  createdAt!: string;

  @ApiProperty({ description: 'Last update timestamp' })
  updatedAt!: string;

  /**
   * Row version for optimistic concurrency control. Echo back as
   * `If-Match: "<version>"` (or `expectedVersion` in the body) on PATCH.
   */
  @ApiProperty({ description: 'Row version for optimistic concurrency control.', example: 1 })
  version!: number;
}
