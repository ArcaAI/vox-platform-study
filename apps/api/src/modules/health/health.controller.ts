import { BuildInfoService, IConfigService } from '@arcaai/applications';
import { Controller, Get, HttpCode, HttpStatus, Inject, Logger, NotFoundException, Param, ServiceUnavailableException } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { HttpService } from '@nestjs/axios';
import { Throttle } from '@nestjs/throttler';
import { Public } from '../../decorators';
import { GracefulShutdownService, IGracefulShutdownService } from '../../services';
import { CanAny } from '../../decorators';

const SERVICE_NAME = 'api';

interface DownstreamService {
  key: string;
  name: string;
  url: string;
  healthEndpoint: string;
}

/**
 * Public-facing shape of a downstream service probe. This shape
 * intentionally OMITS the upstream `version` and `checks` fields the Python
 * services return — those values leak vulnerable-version reconnaissance
 * and internal probe details to whoever holds
 * `Authorize()` (any authenticated user). Full detail still reaches the
 * server-side log entry in `probeService`.
 */
interface ServiceProbeResult {
  status: string;
  service: string;
  uptime_seconds?: number;
  duration_ms?: number;
  error?: string;
}

/**
 * Health Controller for Kubernetes-compatible health checks.
 *
 * Follows the HOPE standardized health contract:
 * - Three status values: "healthy", "degraded", "unhealthy"
 * - Four endpoints: /health (detailed), /health/live, /health/ready, /health/services
 * - Consistent response shape with service, version, timestamp, checks
 *
 * /health/services provides a consolidated view of all downstream microservice
 * health status, eliminating the need for per-service proxy controllers.
 */
@ApiTags('health')
// Lowered from 300 → 30 req/min. With
// /services{/:key} now @Authorize()-gated, the SSRF amplifier surface
// (4 outbound HTTP calls per probe) shrinks, but unauthenticated
// reconnaissance against /live, /ready, /startup, / still benefits from a
// tighter cap. Kubernetes probe schedules sit well below 30/min.
@Throttle({ default: { limit: 30, ttl: 60000 } })
@Controller('health')
export class ApiHealthController {
  private readonly logger = new Logger(ApiHealthController.name);
  private readonly downstreamServices: DownstreamService[];

  constructor(
    @Inject(IGracefulShutdownService)
    private readonly shutdownService: GracefulShutdownService,
    private readonly httpService: HttpService,
    @Inject(IConfigService)
    private readonly configService: IConfigService,
    // Baked build identity (/W8) — replaces the always-`0.1.0`
    // `process.env.npm_package_version` read: the API container runs
    // `node dist/main.js` directly, so pnpm never injects that var in any
    // deployed environment. `/health` surfaces only `version`; branch/SHA/CI
    // detail is operator data and stays behind the admin-gated
    // `/admin/service-releases` surface instead.
    private readonly buildInfoService: BuildInfoService,
  ) {
    // Downstream URLs resolve through the typed
    // `IConfigService.getConfigValue(...)` accessor. The pre-W7 direct
    // `process.env.{SMR,STT,TTS,NLP}_URL` reads are forbidden by
    // the `no-direct-downstream-url-env` lint rule; the env-or-fallback
    // resolution happens once at bootstrap in
    // `ConfigService.loadBaseConfig()`. Built once per controller
    // instance — the URLs do not change at runtime.
    this.downstreamServices = [
      {
        key: 'smr',
        name: 'Summarization',
        url: this.configService.getConfigValue('SMR_URL'),
        healthEndpoint: '/api/v1/health',
      },
      {
        key: 'nlp',
        name: 'Medical NLP',
        url: this.configService.getConfigValue('NLP_URL'),
        healthEndpoint: '/api/v1/health',
      },
      {
        key: 'stt',
        name: 'Speech to Text',
        url: this.configService.getConfigValue('STT_URL'),
        healthEndpoint: '/api/v1/health',
      },
      {
        key: 'tts',
        name: 'Text to Speech',
        url: this.configService.getConfigValue('TTS_URL'),
        healthEndpoint: '/api/v1/health',
      },
      {
        key: 'guardrail',
        name: 'Guardrail',
        url: this.configService.getConfigValue('GUARDRAIL_URL'),
        // Guardrail mounts its health router under `/api` (not `/api/v1`).
        healthEndpoint: '/api/health',
      },
      {
        key: 'harness',
        name: 'Clinical Documentation Harness',
        url: this.configService.getConfigValue('HARNESS_URL'),
        healthEndpoint: '/api/v1/health',
      },
    ];
  }

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

  @Get('services')
  // Requires authentication — the probe payload is sanitised below
  // (version + checks stripped). GLOBAL_ADMIN (`manage all`) has access,
  // matching the other ops/admin surfaces; this downstream ops health is not
  // for plain doctors. A TENANT_ADMIN can also read downstream service
  // health for their tenant dashboard (`read:TenantTelemetry`). The payload is
  // already sanitised platform-infra status (no PHI / per-tenant rows); a plain
  // DOCTOR still holds neither grant and is rejected.
  @CanAny(['manage', 'all'], ['read', 'TenantTelemetry'])
  @ApiOperation({ summary: 'Consolidated health check for all downstream microservices (admin only)' })
  @ApiResponse({ status: 200, description: 'Sanitised health status of SMR, NLP, STT, Guardrail, and Harness services' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  async checkServices() {
    const results = await Promise.allSettled(this.downstreamServices.map((svc) => this.probeService(svc)));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const services: Record<string, any> = {};
    let healthyCount = 0;

    this.downstreamServices.forEach((svc, i) => {
      const result = results[i];
      if (result.status === 'fulfilled') {
        services[svc.key] = result.value;
        if (result.value.status !== 'down') healthyCount++;
      } else {
        services[svc.key] = {
          status: 'down',
          service: svc.name,
          error: result.reason instanceof Error ? result.reason.message : String(result.reason),
        };
      }
    });

    let overallStatus: string;
    if (healthyCount === this.downstreamServices.length) overallStatus = 'healthy';
    else if (healthyCount === 0) overallStatus = 'unhealthy';
    else overallStatus = 'degraded';

    return {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      services,
    };
  }

  @Get('services/:serviceKey')
  // Requires authentication. GLOBAL_ADMIN (`manage all`), as for /services
  // above; also `read:TenantTelemetry` (see /services above).
  @CanAny(['manage', 'all'], ['read', 'TenantTelemetry'])
  @ApiOperation({ summary: 'Health check for a single downstream microservice (admin only)' })
  @ApiParam({ name: 'serviceKey', enum: ['smr', 'nlp', 'stt', 'tts', 'guardrail', 'harness'], description: 'Service key' })
  @ApiResponse({ status: 200, description: 'Sanitised health status of the requested service' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 404, description: 'Unknown service key' })
  async checkServiceByKey(@Param('serviceKey') serviceKey: string): Promise<ServiceProbeResult & { timestamp: string }> {
    const svc = this.downstreamServices.find((s) => s.key === serviceKey);
    if (!svc) {
      throw new NotFoundException(`Unknown service key '${serviceKey}'. Valid keys: ${this.downstreamServices.map((s) => s.key).join(', ')}`);
    }

    const result = await this.probeService(svc);
    return { ...result, timestamp: new Date().toISOString() };
  }

  private async probeService(svc: DownstreamService): Promise<ServiceProbeResult> {
    const start = Date.now();
    try {
      const response = await this.httpService.axiosRef.get(`${svc.url}${svc.healthEndpoint}`, { timeout: 5000 });
      const data = response.data;
      // Full payload (including
      // `version` and `checks`) is logged server-side at debug level for
      // operator visibility. The public response shape OMITS these fields
      // so version + downstream probe details never leak to the client.
      this.logger.debug({
        message: `Health probe complete for ${svc.key}`,
        url: `${svc.url}${svc.healthEndpoint}`,
        upstreamStatus: data?.status,
        upstreamVersion: data?.version,
        upstreamChecks: data?.checks,
      });
      return {
        status: data.status || 'healthy',
        service: svc.name,
        uptime_seconds: data.uptime_seconds,
        duration_ms: Date.now() - start,
      };
    } catch (err) {
      this.logger.warn({
        message: `Health probe failed for ${svc.key}`,
        url: `${svc.url}${svc.healthEndpoint}`,
        error: err instanceof Error ? err.message : String(err),
      });
      return {
        status: 'down',
        service: svc.name,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
