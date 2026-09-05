import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsInt, IsOptional, IsString, MaxLength, Min } from 'class-validator';

/**
 * PUT body for the doctor DNA on/off switch.
 *  - `enabled: true`  → explicit opt-in.
 *  - `enabled: false` → explicit opt-out (allowed under an enabled tenant).
 *  - `enabled: null`  → clear the override (revert to the implicit opt-in default).
 *
 * The toggle is the doctor's own `UserSettings` row (`dna` / `styleEnabled`,
 * TASK-882). `expectedVersion` is the optional OCC token from a prior GET (0
 * while no row exists).
 */
export class UpdateDnaSettingsRequest {
  @ApiProperty({ description: 'Doctor opt-in/out (null clears the override).', nullable: true })
  @IsOptional()
  @IsBoolean()
  enabled!: boolean | null;

  @ApiPropertyOptional({ description: 'Free-text reason recorded on the WORM change row.' })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  reason?: string;

  @ApiPropertyOptional({ description: 'Current DOCTOR-row version for OCC (from a prior GET).', example: 1 })
  @IsOptional()
  @IsInt()
  @Min(1)
  expectedVersion?: number;
}
