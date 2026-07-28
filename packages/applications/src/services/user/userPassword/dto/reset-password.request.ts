import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsOptional, IsString, IsIn } from 'class-validator';
import { BaseRequest } from '../../../../common';

/**
 * Admin-initiated password reset (both flows).
 *
 * `mode`:
 *  - `temporary` — the server sets a temporary password and returns it so the
 *    admin can convey it out-of-band. Optionally pass an explicit
 *    `temporaryPassword`; otherwise one is generated.
 *  - `link` (default) — the server mints a single-use, expiring reset link and
 *    (best-effort) emails it. The token/link is also returned.
 */
export class ResetPasswordRequest extends BaseRequest {
  @ApiPropertyOptional({ description: 'Reset flow', enum: ['temporary', 'link'], default: 'link' })
  @IsOptional()
  @IsIn(['temporary', 'link'])
  mode?: 'temporary' | 'link';

  // Complexity is enforced by the configurable service policy (clear
  // 400 with the unmet rules) — no static @MinLength that would mask it.
  @ApiPropertyOptional({
    description: 'Explicit temporary password (mode=temporary; validated against the complexity policy). Generated when omitted.',
  })
  @IsOptional()
  @IsString()
  temporaryPassword?: string;
}
