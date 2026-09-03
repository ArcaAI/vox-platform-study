import { BuildInfoService } from '@arcaai/applications';
import { Controller, Get, HttpCode, HttpStatus, Inject, ServiceUnavailableException } from '@nestjs/common';
import { ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
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
 * The consolidated downstream-service probes that used to
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
// API-KEY-NOTE — CONSERVATIVE DEFAULT, AWAITING OWNER CLASSIFICATION.
// Since the split every route on this class is `@Public()`, so
// `UnifiedAuthGuard` short-circuits before any API-key check and this
// declaration covers nothing at runtime. It is kept rather than removed
// because dropping it is an auth-posture change owned by sweep,
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

  // the three KUBELET probes are exempt from the class cap above.
  //
  // `TieredThrottlerGuard` is GLOBAL and runs FIRST, ahead of
  // `UnifiedAuthGuard`, so `@Public()` exempts these routes from AUTH but NOT
  // from the throttler. The bucket key is `tenant:${tenantId}` and an
  // unauthenticated request resolves `tenantId` to `null` — so the kubelet's
  // probes and every anonymous caller on the internet shared ONE 30/min bucket.
  //
  // The kubelet is not "well below" that cap. Against the live `hope-api`
  // Deployment: readiness `periodSeconds: 5` = 12/min, liveness
  // `periodSeconds: 30` = 2/min — 14/min steady state, ~47% of the budget, and
  // 26/min (87%) while the startup probe is also running at 5s. A modest
  // anonymous burst therefore exhausts the window and the PROBE takes the 429.
  // A non-2xx is a probe failure to the kubelet, and `failureThreshold: 2` at
  // `periodSeconds: 5` removes the pod from Endpoints ~10s later, until the 60s
  // window rolls: the ~1-minute 09:02→09:03 flap observed on `hope-v2-dev` with
  // no container restart, which also broke TEXT's effective-config pull
  // (`last_refresh_ok:false, sources:{}` — `hope-api:8868` refused).
  //
  // So the cap added to blunt unauthenticated reconnaissance against
  // /live,/ready,/startup was itself a remote unauthenticated way to evict the
  // pod from its Service. A probe reporting on THIS process must never be
  // answerable by shared, remotely-exhaustible state.
  //
  // The reconnaissance concern is unaffected: these three return a constant
  // `{status}` with nothing to enumerate, while `/health` — the detailed route
  // that does expose version and uptime — deliberately KEEPS the 30/min cap.
  //
  // `@SkipThrottle()` with no argument skips the `default` tier only, which is
  // exactly the exposure: `default` is the tier the class `@Throttle` above
  // declares, and `TieredThrottlerGuard` lets every other (opt-in) tier through
  // for a route that did not select it.
  @Get('live')
  @SkipThrottle()
  @Public()
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Liveness probe - is the process running?' })
  @ApiResponse({ status: 200, description: 'Service is alive' })
  liveness() {
    return { status: 'healthy' };
  }

  @Get('ready')
  @SkipThrottle()
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
  @SkipThrottle()
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
