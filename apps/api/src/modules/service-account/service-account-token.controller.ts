import { IServiceAccountService, ServiceAccountTokenRequest, ServiceAccountTokenResponse } from '@arcaai/applications';
import { Body, Controller, HttpCode, Inject, Post, Req } from '@nestjs/common';
import { Throttle } from '@nestjs/throttler';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Public } from '../../decorators';
import { ServiceAccountTokenGuard } from './service-account-token.guard';
import { UseGuards } from '@nestjs/common';

/**
 * `POST /api/v1/auth/service-token` — the ONE route that ever accepts a
 * service-account client secret (TASK-762 §5.4).
 *
 * ─── Why `@Public()` + a dedicated guard ────────────────────────────────────
 *
 * This is the route that ESTABLISHES a credential, so it cannot require one:
 * `UnifiedAuthGuard` has nothing to authenticate here. That is the same shape
 * the `/internal/*` plane already uses (`@Public()` + `InternalServiceTokenGuard`)
 * and the same invariant boot-audit F pins — public, but never UNGUARDED.
 * `ServiceAccountTokenGuard` enforces the shape of the request before any
 * credential comparison runs.
 *
 * Rate limiting is explicit and tight: a credential-exchange endpoint is a
 * brute-force target, and the denial path is deliberately non-enumerable
 * (unknown client and bad secret return the identical 401), so an attacker's
 * only remaining signal is volume.
 *
 * The response carries an OPAQUE token — never a JWT. There is no claim set to
 * get wrong, and revocation is a Redis delete rather than a blocklist. Never
 * put the token, or the secret, in a URL.
 */
@ApiTags('service-account-auth')
@Controller('auth')
export class ServiceAccountTokenController {
  constructor(@Inject(IServiceAccountService) private readonly serviceAccounts: IServiceAccountService) {}

  @Post('service-token')
  @Public()
  @UseGuards(ServiceAccountTokenGuard)
  @Throttle({ default: { limit: 10, ttl: 60000 } })
  @HttpCode(200)
  @ApiOperation({
    summary: 'Exchange a service-account client secret for a short-lived access token',
    description:
      'Returns an opaque, server-validated bearer token (default 15 min) to be presented in the `X-Service-Account-Token` header. Unknown client and bad secret are indistinguishable by design.',
  })
  @ApiResponse({ status: 200, type: undefined, description: 'Token issued.' })
  @ApiResponse({ status: 401, description: 'Invalid client credentials (deliberately non-enumerable).' })
  @ApiResponse({ status: 403, description: 'Working tenant is outside this account allow-list.' })
  @ApiResponse({ status: 429, description: 'Rate limit exceeded.' })
  async exchange(
    @Body() request: ServiceAccountTokenRequest,
    @Req() req: { ip?: string; headers?: Record<string, unknown> },
  ): Promise<ServiceAccountTokenResponse> {
    return this.serviceAccounts.exchangeToken(request, readClientIp(req));
  }
}

function readClientIp(request: { ip?: string; headers?: Record<string, unknown> } | undefined): string {
  const forwarded = request?.headers?.['x-forwarded-for'];
  if (forwarded) {
    const value = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    if (typeof value === 'string') return value.split(',')[0]!.trim();
  }
  return request?.ip ?? 'unknown';
}
