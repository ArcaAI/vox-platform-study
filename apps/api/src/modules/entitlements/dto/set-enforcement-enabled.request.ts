import { ApiProperty } from '@nestjs/swagger';
import { IsBoolean } from 'class-validator';

/**
 * Flip the global entitlements enforcement kill-switch.
 * Mirrors `SetRateLimitEnabledRequest`. GLOBAL_ADMIN-only at the route.
 */
export class SetEnforcementEnabledRequest {
  @ApiProperty({ description: 'Enable (true) or disable (false) entitlements enforcement platform-wide.' })
  @IsBoolean()
  enabled: boolean;
}
