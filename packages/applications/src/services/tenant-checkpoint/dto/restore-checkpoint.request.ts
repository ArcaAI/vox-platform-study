import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { ArrayMinSize, ArrayUnique, IsArray, IsIn, IsOptional, IsString, MaxLength, MinLength } from 'class-validator';
import { RESTORABLE_CATEGORIES, type RestorableCategory } from '../contracts';

export const RESTORE_REASON_MIN = 10;
export const RESTORE_REASON_MAX = 1000;

export class RestoreCheckpointRequest {
  @ApiProperty({
    description: 'What to restore. CLINICAL is restricted to platform administrators.',
    enum: RESTORABLE_CATEGORIES,
    isArray: true,
    example: ['CONFIG_CONTENT'],
  })
  @IsArray()
  @ArrayMinSize(1)
  @ArrayUnique()
  @IsIn([...RESTORABLE_CATEGORIES], { each: true })
  categories!: RestorableCategory[];

  @ApiProperty({ description: 'Why this restore is being done; recorded in the audit trail', minLength: RESTORE_REASON_MIN, maxLength: RESTORE_REASON_MAX })
  @IsString()
  @MinLength(RESTORE_REASON_MIN)
  @MaxLength(RESTORE_REASON_MAX)
  reason!: string;

  // Both break-glass fields are optional at the DTO layer ON PURPOSE: the service maps a missing
  // confirmation to 428 Precondition Required, not a generic 400.
  @ApiPropertyOptional({ description: "Caller's CURRENT password (step-up re-authentication; never logged)" })
  @IsOptional()
  @IsString()
  password?: string;

  @ApiPropertyOptional({ description: "The tenant's current name, typed to confirm" })
  @IsOptional()
  @IsString()
  @MaxLength(500)
  confirmationName?: string;
}
