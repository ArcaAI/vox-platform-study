import { Controller, Get, Inject, Logger, NotFoundException, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { CanAny, ForbidApiKey, ForbidServiceAccount } from '../../decorators';
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
@Controller('admin/monitoring')
// API-KEY-NOTE — CLOSED BY PLANE, NOT BY CONSERVATIVE DEFAULT.
// Originally @ForbidApiKey() as TASK-742's conservative default: the route
// family declared nothing about API-key access, which under the deny-by-
// default rule is a boot failure, and guessing a permissive scope is how the
// original gap was created. TASK-759 moved the prefix to `admin/monitoring`
// (rule P2 — this is an administrative capability, not a business one), so
// the SAME decorator is now the A2 outcome the admin plane requires: the
// admin plane is JWT-only. The declaration is no longer awaiting owner
// classification — the plane classifies it. No key-based consumer ever
// existed on this surface, so the move breaks nothing.
@ForbidApiKey()
// SVC-NOTE (TASK-773, owner decision O-1) — CLOSED to the machine class.
// Like `@ForbidApiKey()` above, this is a decision about WHAT the surface is,
// not a conservative default awaiting classification. Uptime, heartbeats and
// session counts are operator telemetry: their consumer is a human reading the
// admin console's monitoring screen, and the value of the data is in a person
// looking at it. There is no integration a machine identity would drive here,
// so deny-by-default stands and the area is deliberately absent from the
// generated SDK surface — an integrator gets no method that would always 403.
// Re-opening it is a new owner decision, not a code-review call.
@ForbidServiceAccount()
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
  @ApiParam({ name: 'service', enum: ['text', 'stt', 'nlp', 'guardrail', 'harness'], description: 'Service name' })
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
  @ApiParam({ name: 'service', enum: ['text', 'stt', 'nlp', 'guardrail', 'harness'], description: 'Service name' })
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
