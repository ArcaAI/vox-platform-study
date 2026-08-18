import { Controller, Get, Inject, Logger, NotFoundException, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CanAny, ForbidApiKey } from '../../decorators';
import { IServiceHealthMonitoringService } from '@arcaai/applications';
import { HeartbeatRecord, ServiceUptime, SessionsResponse, UptimeResponse } from './dto';

@ApiTags('monitoring')
@ApiBearerAuth()
// Ops monitoring is platform-wide infra data. A TENANT_ADMIN can read their
// own tenant's service sessions/health/uptime (`read:TenantTelemetry`)
// without `manage all`.
// Service uptime/heartbeats/session-counts are platform-infra status (no PHI,
// no per-tenant rows), so there is nothing tenant-specific to filter out here;
// SUPER_ADMIN still passes via `manage:all`, and a plain DOCTOR (neither grant)
// is still rejected.
@CanAny(['manage', 'all'], ['read', 'TenantTelemetry'])
@Throttle({ default: { limit: 300, ttl: 60000 } })
@Controller('monitoring')
// TASK-742 API-KEY-NOTE — CONSERVATIVE DEFAULT, AWAITING OWNER CLASSIFICATION.
// Reason: admin-shaped telemetry export; outside TASK-708 s /admin/*-only approval and has no scope of its own.
// This route family declared nothing about API-key access, which under the
// deny-by-default rule is a boot failure. Rather than guess a scope (guessing
// permissive is how the original gap was created), it is closed explicitly.
// Reversing it is a one-line change to @RequiredScopes('<scope>') once the
// owner confirms a real API-key use case — see the TASK-708 README's
// "Reachability changes awaiting owner review" table.
@ForbidApiKey()
export class MonitoringController {
  private readonly logger = new Logger(MonitoringController.name);

  constructor(
    @Inject(IServiceHealthMonitoringService)
    private readonly monitoringService: IServiceHealthMonitoringService,
  ) {}

  @Get('uptime')
  @ApiOperation({ summary: 'Get uptime data for all services' })
  @ApiResponse({ status: 200, description: 'Uptime data for all services', type: UptimeResponse })
  async getUptime(): Promise<UptimeResponse> {
    this.logger.debug({
      message: 'Request received',
      endpoint: 'uptime',
    });
    return this.monitoringService.getUptime();
  }

  @Get('uptime/:service')
  @ApiOperation({ summary: 'Get uptime data for a specific service' })
  @ApiParam({ name: 'service', enum: ['smr', 'stt', 'nlp', 'guardrail', 'harness'], description: 'Service name' })
  @ApiResponse({ status: 200, description: 'Uptime data for the service', type: ServiceUptime })
  @ApiResponse({ status: 404, description: 'Service not found' })
  async getServiceUptime(@Param('service') service: string): Promise<ServiceUptime> {
    this.logger.debug({
      message: 'Request received',
      endpoint: 'uptime',
      service,
    });
    const result = await this.monitoringService.getServiceUptime(service);

    if (!result) {
      throw new NotFoundException(`Service '${service}' not found`);
    }

    return result;
  }

  @Get('heartbeats/:service')
  @ApiOperation({ summary: 'Get heartbeat history for a service' })
  @ApiParam({ name: 'service', enum: ['smr', 'stt', 'nlp', 'guardrail', 'harness'], description: 'Service name' })
  @ApiResponse({ status: 200, description: 'Heartbeat history', type: [HeartbeatRecord] })
  async getHeartbeats(@Param('service') service: string): Promise<HeartbeatRecord[]> {
    this.logger.debug({
      message: 'Request received',
      endpoint: 'heartbeats',
      service,
    });
    return this.monitoringService.getHeartbeatHistory(service);
  }

  @Get('sessions')
  @ApiOperation({ summary: 'Get active session counts per service' })
  @ApiResponse({ status: 200, description: 'Session counts per service', type: SessionsResponse })
  async getSessions(): Promise<SessionsResponse> {
    this.logger.debug({
      message: 'Request received',
      endpoint: 'sessions',
    });
    return this.monitoringService.getSessionCounts();
  }
}
