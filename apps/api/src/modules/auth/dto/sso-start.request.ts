import { ApiPropertyOptional } from '@nestjs/swagger';
import { IsEmail, IsOptional, IsString } from 'class-validator';

/**
 * TASK-498 D5 — home-realm discovery (HRD). Prefer `email` so the client can
 * route the user to the right IdP from their email domain; `tenantKey`
 * remains an explicit fallback (consistent with today's password-login
 * `tenantKey` requirement) when the domain is unmapped/ambiguous.
 */
export class SsoStartRequest {
  @ApiPropertyOptional({ description: 'User email — routes via the verified email-domain allowlist (HRD)' })
  @IsOptional()
  @IsEmail()
  email?: string;

  @ApiPropertyOptional({ description: 'Explicit tenant key — required when the email domain is not mapped' })
  @IsOptional()
  @IsString()
  tenantKey?: string;
}
