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

  @ApiPropertyOptional({
    description:
      'Reset link carrying the token (mode=link). Absolute on the `console.publicBaseUrl` origin (tenant → platform) when configured; a relative path when it is not — the caller prefixes its own origin.',
  })
  resetPath?: string;

  @ApiPropertyOptional({ description: 'Token lifetime in seconds (mode=link)' })
  expiresInSeconds?: number;

  @ApiPropertyOptional({ description: 'Whether the reset email was accepted for delivery (mode=link)' })
  emailSent?: boolean;

  constructor(init: ResetPasswordResponse) {
    Object.assign(this, init);
  }
}
