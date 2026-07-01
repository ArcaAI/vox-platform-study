import { ApiProperty } from '@nestjs/swagger';

/** TASK-392 (Q9) — current state of the enforcement kill-switch. */
export class EntitlementsEnabledResponse {
  @ApiProperty({ description: 'Whether entitlements enforcement is currently ON platform-wide.' })
  enabled: boolean;
}
