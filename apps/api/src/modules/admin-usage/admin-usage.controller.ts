import { Controller, Get, Inject, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { ClsService } from 'nestjs-cls';
import {
  CostPerEncounterResponse,
  IActiveUserContext,
  IUsageAnalyticsService,
  TopTenantsResponse,
  UsageSummaryResponse,
  UsageTimeseriesResponse,
  periodOf,
} from '@arcaai/applications';
import { CanManage } from '../../decorators';
import { resolveScopedTenantId } from '../../shared/tenant-scope';
import { CostPerEncounterQuery, TopTenantsQuery, UsageSummaryQuery, UsageTimeseriesQuery as UsageTimeseriesQueryDto } from './dto';

/**
 * Admin/global usage-analytics surface, mounted at
 * `/admin/usage/*` (global prefix → `/api/v1/admin/usage/*`).
 *
 * Gated GLOBAL_ADMIN via `@CanManage('UsageAnalytics')` — the same posture as
 * `PlatformMetricsController` (an arbitrary subject satisfied only by the
 * global `manage:all` grant; no tenant-scoped rule is seeded for it). This
 * controller SUPERSEDES `PlatformMetricsController#getConsumption`'s ad-hoc
 * `/admin/platform/consumption` view for ledger-derived numbers — see the
 * G16 migration note on `UsageAnalyticsService`.
 *
 * Tenant scoping (summary/timeseries/cost-per-encounter): `resolveScopedTenantId`
 * — global admins act cross-tenant via `?tenantId=`; a tenant-bound caller is
 * pinned to their own tenant (a foreign `?tenantId=` is rejected, 403).
 *
 * `top-tenants` is the ONE deliberately cross-tenant read on this surface —
 * enforced imperatively in the service (`isSuperAdmin`) because it reads
 * every tenant's rollups by construction; the class-level `@CanManage` guard
 * keeps the deny-by-default boot audit green either way.
 */
@ApiBearerAuth()
@ApiTags('admin-usage')
@Controller('admin/usage')
@CanManage('UsageAnalytics')
export class AdminUsageController {
  constructor(
    @Inject(IUsageAnalyticsService) private readonly usageAnalytics: IUsageAnalyticsService,
    private readonly cls: ClsService<IActiveUserContext>,
  ) {}

  @Get('summary')
  @ApiOperation({ summary: 'Units + rated cost per capability x provider x model for a billing period. BYOK notional split out.' })
  @ApiResponse({ status: 200, type: UsageSummaryResponse })
  summary(@Query() query: UsageSummaryQuery): Promise<UsageSummaryResponse> {
    return this.usageAnalytics.getUsageSummary(this.scopedTenantId(query.tenantId), query.period ?? periodOf(new Date()).label);
  }

  @Get('timeseries')
  @ApiOperation({ summary: 'Bounded-range rollup timeseries for one capability x unit (max 92 days daily / 72h hourly).' })
  @ApiResponse({ status: 200, type: UsageTimeseriesResponse })
  timeseries(@Query() query: UsageTimeseriesQueryDto): Promise<UsageTimeseriesResponse> {
    return this.usageAnalytics.getUsageTimeseries(this.scopedTenantId(query.tenantId), {
      capability: query.capability,
      unit: query.unit,
      granularity: query.granularity,
      from: new Date(query.from),
      to: new Date(query.to),
    });
  }

  @Get('cost-per-encounter')
  @ApiOperation({ summary: 'p50/p90/p99 + count of the Σ INTERNAL-basis cost per consultation over a billing period.' })
  @ApiResponse({ status: 200, type: CostPerEncounterResponse })
  costPerEncounter(@Query() query: CostPerEncounterQuery): Promise<CostPerEncounterResponse> {
    return this.usageAnalytics.getCostPerEncounter(this.scopedTenantId(query.tenantId), query.period ?? periodOf(new Date()).label);
  }

  @Get('top-tenants')
  @ApiOperation({
    summary: 'GLOBAL-ADMIN-only cross-tenant top-N by rollup cost. Every other route on this controller is tenant-scoped; this one is not.',
  })
  @ApiResponse({ status: 200, type: TopTenantsResponse })
  topTenants(@Query() query: TopTenantsQuery): Promise<TopTenantsResponse> {
    return this.usageAnalytics.getTopTenants(query.period ?? periodOf(new Date()).label, { limit: query.limit ?? 10, capability: query.capability });
  }

  private scopedTenantId(queryTenantId?: string): string {
    return resolveScopedTenantId(this.cls.get('user'), this.cls.get('tenantId'), queryTenantId);
  }
}
