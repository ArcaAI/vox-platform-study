import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';

export const CHECKPOINT_PASSPHRASE_MIN = 12;
export const CHECKPOINT_PASSPHRASE_MAX = 256;

export class CreateCheckpointRequest {
  @ApiProperty({ description: 'Human-readable label shown in the checkpoint list', example: 'Before the October agent rewrite', maxLength: 200 })
  @IsString()
  @MinLength(1)
  @MaxLength(200)
  label!: string;

  @ApiProperty({ description: 'Capture media bytes (audio, documents) in addition to database rows', example: true })
  @IsBoolean()
  includesMedia!: boolean;

  @ApiPropertyOptional({
    description:
      'Optional passphrase (12-256 characters) that lets the archive be opened offline. Used only inside this request to wrap the ' +
      'archive key — it is never stored and cannot be recovered.',
    minLength: CHECKPOINT_PASSPHRASE_MIN,
    maxLength: CHECKPOINT_PASSPHRASE_MAX,
  })
  @IsOptional()
  @IsString()
  @MinLength(CHECKPOINT_PASSPHRASE_MIN)
  @MaxLength(CHECKPOINT_PASSPHRASE_MAX)
  passphrase?: string;
}
