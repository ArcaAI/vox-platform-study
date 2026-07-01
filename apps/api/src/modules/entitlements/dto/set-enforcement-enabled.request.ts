import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

/**
 * TASK-392 (Q9) — flip the global entitlements enforcement kill-switch.
 * Mirrors `SetRateLimitEnabledRequest`. SUPER_ADMIN-only at the route.
 */
export class SetEnforcementEnabledRequest {
  @ApiProperty({ description: 'Enable (true) or disable (false) entitlements enforcement platform-wide.' })
  @IsBoolean()
  enabled: boolean;
}
