import { ApiProperty } from '@nestjs/swagger';

/**
 * TASK-400 — generic acknowledgement. The body is IDENTICAL whether or not the
 * email matched an account (anti-enumeration); the token is never returned.
 */
export class ForgotPasswordResponse {
  @ApiProperty({ example: true })
  success: boolean;

  @ApiProperty({ example: 'If an account exists for that email, a password reset link has been sent.' })
  message: string;

  constructor(init: ForgotPasswordResponse) {
    Object.assign(this, init);
  }
}
