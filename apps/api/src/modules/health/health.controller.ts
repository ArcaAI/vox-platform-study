import { Controller, Get, HttpCode, HttpStatus, Inject, Logger, NotFoundException, Param, ServiceUnavailableException } from '@nestjs/common';
import { ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { HttpService } from '@nestjs/axios';
import { Throttle } from '@nestjs/throttler';
import { GracefulShutdownService, IGracefulShutdownService } from '../../services';
import { Authorize } from '../../decorators';

const SERVICE_NAME = 'api';
// eslint-disable-next-line turbo/no-undeclared-env-vars
const SERVICE_VERSION = process.env.npm_package_version || '0.1.0';

interface DownstreamService {
  key: string;
  name: string;
  url: string;
  healthEndpoint: string;
}

/**
 * Public-facing shape of a downstream service probe. TASK-307 W5.1 / AC-15
 * intentionally OMITS the upstream `version` and `checks` fields the Python
 * services return — those values leak vulnerable-version reconnaissance
 * (audit E-3) and internal probe details (audit C-8) to whoever holds
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

const DOWNSTREAM_SERVICES: DownstreamService[] = [
  {
    key: 'tts',
    name: 'Text to Speech',
    // eslint-disable-next-line turbo/no-undeclared-env-vars
    url: process.env.TTS_URL || 'http://localhost:8863',
    healthEndpoint: '/api/v1/health',
  },
  {
    key: 'smr',
    name: 'Summarization',
    // eslint-disable-next-line turbo/no-undeclared-env-vars
    url: process.env.SMR_SERVICE_URL || process.env.SMR_URL || 'http://localhost:8862',
    healthEndpoint: '/api/v1/health',
  },
  {
    key: 'nlp',
    name: 'Medical NLP',
    url: process.env.NLP_URL || 'http://localhost:8864',
    healthEndpoint: '/api/v1/health',
  },
  {
    key: 'stt',
    name: 'Speech to Text',
    url: process.env.STT_V2_URL || 'http://localhost:8861',
    healthEndpoint: '/api/v1/health',
  },
];

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
// TASK-307 W5.1 / AC-15 / audit D-11 — lowered from 300 → 30 req/min. With
// /services{/:key} now @Authorize()-gated, the SSRF amplifier surface
// (4 outbound HTTP calls per probe) shrinks, but unauthenticated
// reconnaissance against /live, /ready, /startup, / still benefits from a
// tighter cap. Kubernetes probe schedules sit well below 30/min.
@Throttle({ default: { limit: 30, ttl: 60000 } })
@Controller('health')
export class ApiHealthController {
  private readonly logger = new Logger(ApiHealthController.name);

  constructor(
    @Inject(IGracefulShutdownService)
    private readonly shutdownService: GracefulShutdownService,
    private readonly httpService: HttpService,
  ) {}

  @Get('live')
  @HttpCode(HttpStatus.OK)
  @ApiOperation({ summary: 'Liveness probe - is the process running?' })
  @ApiResponse({ status: 200, description: 'Service is alive' })
  liveness() {
    return { status: 'healthy' };
  }

  @Get('ready')
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
      version: SERVICE_VERSION,
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
  // TASK-307 W5.1 / AC-15 — close audit C-8 (was unauthenticated). Any
  // authenticated caller is permitted; the probe payload itself is
  // sanitised below (version + checks stripped per audit E-3).
  @Authorize()
  @ApiOperation({ summary: 'Consolidated health check for all downstream microservices (authenticated)' })
  @ApiResponse({ status: 200, description: 'Sanitised health status of TTS, SMR, NLP, and STT services' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  async checkServices() {
    const results = await Promise.allSettled(DOWNSTREAM_SERVICES.map((svc) => this.probeService(svc)));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const services: Record<string, any> = {};
    let healthyCount = 0;

    DOWNSTREAM_SERVICES.forEach((svc, i) => {
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
    if (healthyCount === DOWNSTREAM_SERVICES.length) overallStatus = 'healthy';
    else if (healthyCount === 0) overallStatus = 'unhealthy';
    else overallStatus = 'degraded';

    return {
      status: overallStatus,
      timestamp: new Date().toISOString(),
      services,
    };
  }

  @Get('services/:serviceKey')
  // TASK-307 W5.1 / AC-15 — close audit C-8.
  @Authorize()
  @ApiOperation({ summary: 'Health check for a single downstream microservice (authenticated)' })
  @ApiParam({ name: 'serviceKey', enum: ['tts', 'smr', 'nlp', 'stt'], description: 'Service key' })
  @ApiResponse({ status: 200, description: 'Sanitised health status of the requested service' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  @ApiResponse({ status: 404, description: 'Unknown service key' })
  async checkServiceByKey(@Param('serviceKey') serviceKey: string): Promise<ServiceProbeResult & { timestamp: string }> {
    const svc = DOWNSTREAM_SERVICES.find((s) => s.key === serviceKey);
    if (!svc) {
      throw new NotFoundException(`Unknown service key '${serviceKey}'. Valid keys: ${DOWNSTREAM_SERVICES.map((s) => s.key).join(', ')}`);
    }

    const result = await this.probeService(svc);
    return { ...result, timestamp: new Date().toISOString() };
  }

  private async probeService(svc: DownstreamService): Promise<ServiceProbeResult> {
    const start = Date.now();
    try {
      const response = await this.httpService.axiosRef.get(`${svc.url}${svc.healthEndpoint}`, { timeout: 5000 });
      const data = response.data;
      // TASK-307 W5.1 / AC-15 / audit C-8 + E-3 — full payload (including
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
        service: data.service || svc.name,
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
