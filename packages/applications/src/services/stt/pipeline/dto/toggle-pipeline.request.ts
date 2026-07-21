import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

/**
 * Enable/disable an ASR pipeline. Maps to the entity's
 * `resourceStatus` (ENABLED ⇄ DISABLED) via the OCC-aware write path.
 */
export class TogglePipelineRequest {
  @ApiProperty({ description: 'true → ENABLED, false → DISABLED', example: true })
  @IsBoolean()
  enabled: boolean;
}
