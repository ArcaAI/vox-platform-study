import { BuildInfoService } from '@arcaai/applications';
import { Controller, Get, HttpCode, HttpStatus, Inject, ServiceUnavailableException } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { Public, ForbidApiKey } from '../../decorators';
import { GracefulShutdownService, IGracefulShutdownService } from '../../services';

const SERVICE_NAME = 'api';

/**
 * Health Controller for Kubernetes-compatible health checks.
 *
 * Follows the HOPE standardized health contract:
 * - Three status values: "healthy", "degraded", "unhealthy"
 * - Four PUBLIC probes: /health (detailed), /health/live, /health/ready,
 *   /health/startup
 * - Consistent response shape with service, version, timestamp, checks
 *
 * TASK-759 (rule P2): the consolidated downstream-service probes that used to
 * live here (`/health/services{,/:serviceKey}`) were CASL-gated ops telemetry
 * on a public prefix. They moved to `AdminHealthServicesController`
 * (`api/v1/admin/health/services`) unchanged. This class is now PUBLIC-ONLY —
 * every route on it is a k8s probe, which is why it no longer injects an HTTP
 * client or resolves downstream URLs.
 */
@ApiTags('health')
// Lowered from 300 → 30 req/min: unauthenticated reconnaissance against
// /live, /ready, /startup, / benefits from a tight cap, and Kubernetes probe
// schedules sit well below 30/min.
@Throttle({ default: { limit: 30, ttl: 60000 } })
@Controller('health')
// TASK-742 API-KEY-NOTE — CONSERVATIVE DEFAULT, AWAITING OWNER CLASSIFICATION.
// Since the TASK-759 split every route on this class is `@Public()`, so
// `UnifiedAuthGuard` short-circuits before any API-key check and this
// declaration covers nothing at runtime. It is kept rather than removed
// because dropping it is an auth-posture change owned by TASK-757's A2 sweep,
// not by a route-taxonomy ticket: a future non-public route added here would
// otherwise be silently undeclared instead of failing boot.
@ForbidApiKey()
export class ApiHealthController {
  constructor(
    @Inject(IGracefulShutdownService)
    private readonly shutdownService: GracefulShutdownService,
    // Baked build identity — replaces the always-`0.1.0`
    // `process.env.npm_package_version` read: the API container runs
    // `node dist/main.js` directly, so pnpm never injects that var in any
    // deployed environment. `/health` surfaces only `version`; branch/SHA/CI
    // detail is operator data and stays behind the admin-gated
    // `/admin/service-releases` surface instead.
    private readonly buildInfoService: BuildInfoService,
  ) {}

  @Get('live')
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Liveness probe - is the process running?' })
  @ApiResponse({ status: 200, description: 'Service is alive' })
  liveness() {
    return { status: 'healthy' };
  }

  @Get('ready')
  @Public()
  @ApiOperation({ summary: 'Readiness probe - is the service ready for traffic?' })
  @ApiResponse({ status: 200, description: 'Service is ready' })
  @ApiResponse({ status: 503, description: 'Service is not ready' })
  readiness() {
    if (!this.shutdownService.isReady) {
      throw new ServiceUnavailableException({
        status: 'unhealthy',
        message: this.shutdownService.isShuttingDown ? 'Service is shutting down' : 'Service is not ready',
      });
    }
    return { status: 'healthy' };
  }

  @Get('startup')
  @Public()
  @ApiOperation({ summary: 'Startup probe - has the service finished initialization?' })
  @ApiResponse({ status: 200, description: 'Service has started' })
  @ApiResponse({ status: 503, description: 'Service is still starting' })
  startup() {
    if (!this.shutdownService.isReady && !this.shutdownService.isShuttingDown) {
      throw new ServiceUnavailableException({
        status: 'unhealthy',
        message: 'Service is still initializing',
      });
    }
    return { status: 'healthy' };
  }

  @Get()
  @Public()
  @ApiOperation({ summary: 'Detailed health check' })
  @ApiResponse({ status: 200, description: 'Health check information' })
  check() {
    const isShuttingDown = this.shutdownService.isShuttingDown;
    const isReady = this.shutdownService.isReady;

    let status: string;
    if (isShuttingDown) status = 'unhealthy';
    else if (isReady) status = 'healthy';
    else status = 'degraded';

    return {
      status,
      service: SERVICE_NAME,
      version: this.buildInfoService.getBuildInfo().version,
      uptime_seconds: Math.round(process.uptime() * 10) / 10,
      timestamp: new Date().toISOString(),
      checks: {
        process: {
          status: 'healthy',
          duration_ms: 0,
        },
      },
    };
  }
}
