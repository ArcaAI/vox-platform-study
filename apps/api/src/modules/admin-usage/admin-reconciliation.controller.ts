import { Controller, Get, HttpCode, Inject, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { IShadowMeteringService, ProviderReconciliationRunResponse, ProviderReconciliationSweepResult } from '@arcaai/applications';

import { CanManage } from '../../decorators';
import { ReconciliationRunsQuery } from './dto';

/**
 * Provider-reconciliation audit trail (rule 6), mounted at
 * `/admin/usage/reconciliation/*`.
 *
 * READ-ONLY. There is deliberately no route to create, edit or delete a run:
 * the trail is the control that answers an invoice dispute, and one that can be
 * rewritten after the fact answers nothing. Runs are produced by the sweep, not
 * by an operator.
 *
 * PLATFORM-WIDE and therefore GLOBAL_ADMIN-only via `@CanManage('UsageAnalytics')`
 * — the same gate as the rest of this module. These rows are aggregate VENDOR
 * totals for the whole platform; unlike the usage endpoints next door there is
 * no `?tenantId=` scoping, because no vendor exposes per-tenant cost and a
 * tenant must never see platform-wide spend.
 */
@ApiBearerAuth()
@ApiTags('admin-usage')
@Controller('admin/usage/reconciliation')
@CanManage('UsageAnalytics')
export class AdminReconciliationController {
  constructor(@Inject(IShadowMeteringService) private readonly shadowMetering: IShadowMeteringService) {}

  @Get('runs')
  @ApiOperation({
    summary: 'Provider-reconciliation runs, newest first. Includes SKIPPED and FAILED attempts — the gap is the point.',
    description:
      'Every attempt is recorded, not just successful comparisons: "not reconciled since March because the credential expired" is exactly what an audit asks about. Quantities are strings (Decimal columns); null means no comparison happened and is never 0.',
  })
  @ApiQuery({ name: 'provider', required: false })
  @ApiQuery({ name: 'breachedOnly', required: false, type: Boolean })
  @ApiQuery({ name: 'limit', required: false, type: Number })
  @ApiResponse({ status: 200, type: ProviderReconciliationRunResponse, isArray: true })
  runs(@Query() query: ReconciliationRunsQuery): Promise<ProviderReconciliationRunResponse[]> {
    return this.shadowMetering.findReconciliationRuns({
      provider: query.provider,
      breachedOnly: query.breachedOnly,
      from: query.from ? new Date(query.from) : undefined,
      to: query.to ? new Date(query.to) : undefined,
      limit: query.limit,
    });
  }

  @Post('run')
  @HttpCode(200)
  @ApiOperation({
    summary: 'Run the reconciliation sweep NOW against the last settled window, and record the attempts.',
    description:
      'Not a mutation of business data: the sweep only READS the ledger and each vendor report, then appends audit rows. It never writes to the ledger (§6 rule 5). Provided because the scheduled sweep ships OFF, so without it the audit trail stays empty until an operator enables the cron.',
  })
  @ApiResponse({ status: 200 })
  run(): Promise<ProviderReconciliationSweepResult> {
    return this.shadowMetering.reconcileProviders();
  }

  @Get('latest')
  @ApiOperation({ summary: 'Most recent run per provider — the status board.' })
  @ApiResponse({ status: 200, type: ProviderReconciliationRunResponse, isArray: true })
  latest(): Promise<ProviderReconciliationRunResponse[]> {
    return this.shadowMetering.findLatestReconciliationPerProvider();
  }
}
