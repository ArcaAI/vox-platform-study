import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

/**
 * Result of an admin-initiated reset. Shape depends on `mode`.
 */
export class ResetPasswordResponse {
  @ApiProperty({ description: 'The flow that was executed', enum: ['temporary', 'link'] })
  mode!: 'temporary' | 'link';

  @ApiPropertyOptional({ description: 'Temporary password (mode=temporary) — convey out-of-band' })
  temporaryPassword?: string;

  @ApiPropertyOptional({ description: 'Reset token (mode=link)' })
  token?: string;

  @ApiPropertyOptional({ description: 'Relative reset path carrying the token (mode=link)' })
  resetPath?: string;

  @ApiPropertyOptional({ description: 'Token lifetime in seconds (mode=link)' })
  expiresInSeconds?: number;

  @ApiPropertyOptional({ description: 'Whether the reset email was accepted for delivery (mode=link)' })
  emailSent?: boolean;

  constructor(init: ResetPasswordResponse) {
    Object.assign(this, init);
  }
}
