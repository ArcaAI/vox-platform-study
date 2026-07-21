import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * A single snapshot of an ASR pipeline's YAML config. One row is
 * written on every config change, with a monotonically increasing
 * `versionNumber`. Surfaced for the versions list + diff/view UI.
 */
export class PipelineVersionResponse {
  @ApiProperty({ description: 'Version snapshot ID' })
  id: string;

  @ApiProperty({ description: 'Owning pipeline ID' })
  asrPipelineId: string;

  @ApiProperty({ description: 'Monotonic version number (1-based)' })
  versionNumber: number;

  @ApiProperty({ description: 'Snapshotted YAML configuration' })
  configYaml: string;

  @ApiPropertyOptional({ description: 'Pipeline name at snapshot time' })
  name?: string | null;

  @ApiPropertyOptional({ description: 'Pipeline description at snapshot time' })
  description?: string | null;

  @ApiPropertyOptional({ description: 'Reason supplied for the change' })
  changeReason?: string | null;

  @ApiPropertyOptional({ description: 'User ID who made the change' })
  changedBy?: string | null;

  @ApiProperty({ description: 'Snapshot creation timestamp (ISO 8601)' })
  createdAt: string;
}
