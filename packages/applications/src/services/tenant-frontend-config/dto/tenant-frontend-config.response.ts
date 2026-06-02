import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ResourceStatusType } from '@arcaai/domains';
import { FrontendPipelineConfigJson } from './frontend-pipeline-config';

/**
 * Per-tenant frontend audio-pipeline defaults (TASK-328 A6) as returned to
 * admin callers. Applies to ALL users of the tenant. `version` is the OCC
 * token — echo it back as `If-Match: "<version>"` (or `expectedVersion`) on
 * the next PUT.
 */
export class TenantFrontendConfigResponse {
  @ApiProperty({ description: 'Config ID' })
  id: string;

  @ApiProperty({ description: 'Tenant ID' })
  tenantId: string;

  @ApiPropertyOptional({ description: 'Default ASR model slug/id for the tenant' })
  asrModel?: string | null;

  @ApiProperty({ description: 'Enable browser noise cancellation by default' })
  noiseCancel: boolean;

  @ApiProperty({ description: 'Enable voice-activity detection by default' })
  vad: boolean;

  @ApiProperty({ description: 'Enable voice enrollment by default' })
  voiceEnrollment: boolean;

  @ApiProperty({ description: 'Enable speaker diarization by default' })
  diarization: boolean;

  @ApiPropertyOptional({ description: 'Typed advanced configuration (see FrontendPipelineConfigJson)' })
  configJson?: FrontendPipelineConfigJson | null;

  @ApiPropertyOptional({ description: 'Resource status', enum: ResourceStatusType })
  resourceStatus?: ResourceStatusType;

  @ApiProperty({ description: 'Creation timestamp (ISO 8601)' })
  createdAt: string;

  @ApiProperty({ description: 'Last update timestamp (ISO 8601)' })
  updatedAt: string;

  @ApiProperty({
    description: 'Row version for optimistic concurrency. Echo as `If-Match: "<version>"` or `expectedVersion` on PUT.',
    example: 3,
  })
  version: number;
}
