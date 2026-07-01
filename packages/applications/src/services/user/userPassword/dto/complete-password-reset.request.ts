import { ApiProperty } from '@nestjs/swagger';
import { IsString, MinLength } from 'class-validator';
import { BaseRequest } from '../../../../common';

/**
 * TASK-388 #8 — public completion of a password reset. Consumes the single-use
 * token minted by the admin reset-link flow and sets the new password.
 */
export class CompletePasswordResetRequest extends BaseRequest {
  @ApiProperty({ description: 'The single-use reset token' })
  @IsString()
  token!: string;

  @ApiProperty({ description: 'The new password (min length 8)' })
  @IsString()
  @MinLength(8)
  newPassword!: string;
}
