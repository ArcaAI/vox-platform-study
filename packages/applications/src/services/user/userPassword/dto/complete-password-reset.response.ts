import { ApiProperty } from '@nestjs/swagger';

/**
 * TASK-388 #8 — result of a completed password reset.
 */
export class CompletePasswordResetResponse {
  @ApiProperty({ description: 'Whether the password was successfully reset' })
  success!: boolean;

  constructor(init: CompletePasswordResetResponse) {
    Object.assign(this, init);
  }
}
