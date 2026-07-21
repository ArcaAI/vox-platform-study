import { Body, Controller, Get, Inject, Param, Put } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import { IRateLimitAdminService, type RateLimitPolicy } from '@arcaai/applications';
import { Authorize } from '../../decorators';
import { RateLimitPolicyResponse, SetRateLimitEnabledRequest, SetRateLimitRouteRequest, SetRateLimitTierRequest } from './dto';

/**
 * System-admin surface for live, DB-backed rate-limit configuration.
 *
 * Reachable at `/api/v1/admin/rate-limit`. Gated to GLOBAL_ADMIN only: the
 * `manage all` permission is granted exclusively by the `system-full-access`
 * policy (tenant admins hold `manage GlobalSetting` scoped to their own tenant,
 * which must NOT let them retune the platform-wide gateway limits).
 *
 * Every mutation persists a `rate-limit.*` GlobalSetting row and refreshes the
 * AppSettings cache, so changes take effect within the cache window without a
 * redeploy — the same model `dna-regen.*` uses for the cron scheduler.
 */
@ApiTags('admin-rate-limit')
@ApiBearerAuth()
@Authorize(['manage', 'all'])
@Controller('admin/rate-limit')
export class RateLimitAdminController {
  constructor(
    @Inject(IRateLimitAdminService)
    private readonly rateLimitAdmin: IRateLimitAdminService,
  ) {}

  @Get()
  @ApiOperation({ summary: 'Get the effective rate-limit policy (global flag, tier baselines, known-route overrides).' })
  @ApiOkResponse({ type: RateLimitPolicyResponse })
  getPolicy(): RateLimitPolicy {
    return this.rateLimitAdmin.getPolicy();
  }

  @Put('enabled')
  @ApiOperation({ summary: 'Flip the global rate-limit kill-switch.' })
  @ApiOkResponse({ type: RateLimitPolicyResponse })
  setEnabled(@Body() body: SetRateLimitEnabledRequest): Promise<RateLimitPolicy> {
    return this.rateLimitAdmin.setEnabled(body.enabled);
  }

  @Put('tiers/:tier')
  @ApiOperation({ summary: 'Update a tier baseline (default | strict | heavy | relaxed).' })
  @ApiParam({ name: 'tier', enum: ['default', 'strict', 'heavy', 'relaxed'] })
  @ApiOkResponse({ type: RateLimitPolicyResponse })
  setTier(@Param('tier') tier: string, @Body() body: SetRateLimitTierRequest): Promise<RateLimitPolicy> {
    return this.rateLimitAdmin.setTier(tier, body);
  }

  @Put('routes/:routeId')
  @ApiOperation({ summary: 'Update a per-endpoint override for a known throttled route (e.g. auth.login).' })
  @ApiParam({ name: 'routeId', example: 'auth.login' })
  @ApiOkResponse({ type: RateLimitPolicyResponse })
  setRoute(@Param('routeId') routeId: string, @Body() body: SetRateLimitRouteRequest): Promise<RateLimitPolicy> {
    return this.rateLimitAdmin.setRoute(routeId, body);
  }
}
