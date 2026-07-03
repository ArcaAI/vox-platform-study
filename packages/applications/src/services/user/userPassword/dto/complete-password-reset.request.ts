import { ApiProperty } from '@nestjs/swagger';
import { IsString } from 'class-validator';
import { BaseRequest } from '../../../../common';

/**
 * TASK-388 #8 — public completion of a password reset. Consumes the single-use
 * token minted by the admin reset-link or forgot-password flow and sets the
 * new password. TASK-400: length / complexity is enforced by the CONFIGURABLE
 * service policy (`security.password.*` GlobalSettings) so the 400 carries the
 * precise unmet rules — no static @MinLength here that would mask it.
 */
export class CompletePasswordResetRequest extends BaseRequest {
  @ApiProperty({ description: 'The single-use reset token' })
  @IsString()
  token!: string;

  @ApiProperty({ description: 'The new password (validated against the configurable complexity policy; default min length 12)' })
  @IsString()
  newPassword!: string;
}
