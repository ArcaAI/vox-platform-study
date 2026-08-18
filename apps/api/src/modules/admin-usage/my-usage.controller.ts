import { BadRequestException, Controller, Get, Inject, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import { BudgetBurndownResponse, IActiveUserContext, IUsageAnalyticsService, UsageSummaryResponse, periodOf } from '@arcaai/applications';
import { Authorize, ForbidApiKey } from '../../decorators';
import { BudgetBurndownQuery, MyUsageSummaryQuery } from './dto';

/**
 * Tenant self-service usage reads (D8), mounted at
 * `/usage/me/*` (global prefix → `/api/v1/usage/me/*`).
 *
 * Same posture as `MyBillingController` — `read Tenant`, always the CLS
 * tenant, no `tenantId` override, foreign ids are structurally impossible
 * (there is no by-id route here). READ-ONLY by construction.
 */
@ApiBearerAuth()
@ApiTags('usage')
@Controller('usage')
// TASK-742 API-KEY-NOTE — CONSERVATIVE DEFAULT, AWAITING OWNER CLASSIFICATION.
// Reason: self-service usage reads.
// This route family declared nothing about API-key access, which under the
// deny-by-default rule is a boot failure. Rather than guess a scope (guessing
// permissive is how the original gap was created), it is closed explicitly.
// Reversing it is a one-line change to @RequiredScopes('<scope>') once the
// owner confirms a real API-key use case — see the TASK-708 README's
// "Reachability changes awaiting owner review" table.
@ForbidApiKey()
export class MyUsageController {
  constructor(
    @Inject(IUsageAnalyticsService) private readonly usageAnalytics: IUsageAnalyticsService,
    private readonly cls: ClsService<IActiveUserContext>,
  ) {}

  @Get('me/summary')
  @Authorize(['read', 'Tenant'])
  @ApiOperation({ summary: "The caller's own tenant's usage summary for a billing period. Defaults to the current UTC month." })
  @ApiResponse({ status: 200, type: UsageSummaryResponse })
  summary(@Query() query: MyUsageSummaryQuery): Promise<UsageSummaryResponse> {
    return this.usageAnalytics.getUsageSummary(this.ownTenantId(), query.period ?? periodOf(new Date()).label);
  }

  @Get('me/burndown')
  @Authorize(['read', 'Tenant'])
  @ApiOperation({ summary: 'Allowances vs month-to-date usage vs days elapsed, with a linear exceed projection. Defaults to the current UTC month.' })
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
