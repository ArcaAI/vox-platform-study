import { Controller, Get, Inject, Logger, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { IPlatformMetricsService, PlatformMetricsResponse, OpenSocketsResponse, ConsumptionRollupResponse } from '@arcaai/applications';
import { CanManage, ForbidApiKey, RequiredSvcScopes } from '../../decorators';

/**
 * Platform runtime metrics surface.
 *
 * Platform-wide ops data, so the whole controller is gated to SUPER_ADMIN via
 * `@CanManage('PlatformMetrics')` (satisfied by the GLOBAL `manage:all` grant;
 * no tenant-scoped rule is seeded for this subject). A tenant-admin / doctor
 * holds neither `manage:PlatformMetrics` nor `manage:all`, so the global
 * `UnifiedAuthGuard` returns 403.
 *
 * All three reads are Redis-cached in the service (~12s TTL) and emit NO audit
 * event (decision #8). They degrade gracefully when Prometheus/Redis are down
 * (the service returns zero-ish/empty shapes rather than throwing).
 */
@ApiBearerAuth()
@ApiTags('admin-platform-metrics')
@ForbidApiKey()
@RequiredSvcScopes('svc:admin:platform-metrics:read')
@Controller('admin/platform')
@CanManage('PlatformMetrics')
export class PlatformMetricsController {
  private readonly logger = new Logger(PlatformMetricsController.name);

  constructor(
    @Inject(IPlatformMetricsService)
    private readonly platformMetricsService: IPlatformMetricsService,
  ) {}

  @Get('metrics')
  @ApiOperation({ summary: 'Platform runtime metrics (requests/min, error rate, P95, sockets, models, series)' })
  @ApiResponse({ status: 200, description: 'Platform runtime metrics', type: PlatformMetricsResponse })
  async getMetrics(): Promise<PlatformMetricsResponse> {
    return this.platformMetricsService.getPlatformMetrics();
  }

  @Get('sockets')
  @ApiOperation({ summary: 'Open WebSocket count (live, multi-instance aggregate)' })
  @ApiResponse({ status: 200, description: 'Open-sockets tile', type: OpenSocketsResponse })
  async getSockets(): Promise<OpenSocketsResponse> {
    return this.platformMetricsService.getOpenSockets();
  }

  @Get('consumption')
  @ApiOperation({ summary: 'Consumption / usage roll-up (transcription minutes, summaries-24h, storage, consultations)' })
  @ApiQuery({
    name: 'tenantId',
    required: false,
    type: String,
    description: 'Scope the roll-up to one tenant; omit for a platform-wide (cross-tenant) roll-up.',
  })
  @ApiResponse({ status: 200, description: 'Consumption roll-up', type: ConsumptionRollupResponse })
  async getConsumption(@Query('tenantId') tenantId?: string): Promise<ConsumptionRollupResponse> {
    return this.platformMetricsService.getConsumptionRollup(tenantId && tenantId.length > 0 ? tenantId : null);
  }
}
