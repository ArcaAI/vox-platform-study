import { BadRequestException, Controller, Get, Inject, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { BudgetBurndownResponse, IActiveUserContext, IUsageAnalyticsService, UsageSummaryResponse, periodOf } from '@arcaai/applications';
import { Authorize, RequiredScopes } from '../../decorators';
import { BudgetBurndownQuery, MyUsageSummaryQuery } from './dto';

/**
 * Tenant self-service usage reads (D8), mounted at
 * `/usage/me/*` (global prefix → `/api/v1/usage/me/*`).
 *
 * Same posture as `MyBillingController` — `read Tenant`, always the CLS
 * tenant, no `tenantId` override, foreign ids are structurally impossible
 * (there is no by-id route here). READ-ONLY by construction.
 */
/**
 * TASK-758 — the counterpart to `/user/me/*`'s bound-user rule: the bare
 * "mine" surfaces resolve to the key's TENANT, via the CLS `tenantId` the
 * guard sets from `apiKeyEntity.tenantId`. Different resolution, so it gets
 * its own sentence rather than a shared one.
 */
const ME_IS_THE_KEY_TENANT = "Under API-key authentication this resolves to the key's **tenant**.";

@ApiBearerAuth()
@ApiTags('usage')
@Controller('usage')
// API-KEY-NOTE: policy A1. Same posture and same scope as the sibling
// billing reads: the key's OWN tenant, no `tenantId` override, no by-id
// route, read-only. An integrator needs this to watch its own burn rate.
@RequiredScopes('tenant:account:read')
export class MyUsageController {
  constructor(
    @Inject(IUsageAnalyticsService) private readonly usageAnalytics: IUsageAnalyticsService,
    private readonly cls: ClsService<IActiveUserContext>,
  ) {}

  @Get('me/summary')
  @Authorize(['read', 'Tenant'])
  @ApiOperation({
    summary: "The caller's own tenant's usage summary for a billing period. Defaults to the current UTC month.",
    description: ME_IS_THE_KEY_TENANT,
  })
  @ApiResponse({ status: 200, type: UsageSummaryResponse })
  summary(@Query() query: MyUsageSummaryQuery): Promise<UsageSummaryResponse> {
    return this.usageAnalytics.getUsageSummary(this.ownTenantId(), query.period ?? periodOf(new Date()).label);
  }

  @Get('me/burndown')
  @Authorize(['read', 'Tenant'])
  @ApiOperation({
    summary: 'Allowances vs month-to-date usage vs days elapsed, with a linear exceed projection. Defaults to the current UTC month.',
    description: ME_IS_THE_KEY_TENANT,
  })
  @ApiResponse({ status: 200, type: BudgetBurndownResponse })
  burndown(@Query() query: BudgetBurndownQuery): Promise<BudgetBurndownResponse> {
    return this.usageAnalytics.getBudgetBurndown(this.ownTenantId(), query.period ?? periodOf(new Date()).label);
  }

  private ownTenantId(): string {
    const tenantId = this.cls.get('tenantId');
    if (!tenantId) {
      throw new BadRequestException('Tenant context is required. Global-admins must use the /admin/usage endpoints.');
    }
    return tenantId;
  }
}
