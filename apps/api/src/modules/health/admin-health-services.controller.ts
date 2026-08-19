import { IConfigService } from '@arcaai/applications';
import { Controller, Get, Inject, Logger, NotFoundException, Param } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiResponse, ApiTags } from '@nestjs/swagger';
import { HttpService } from '@nestjs/axios';
import { Throttle } from '@nestjs/throttler';
import { CanAny, ForbidApiKey, ForbidServiceAccount } from '../../decorators';
import { redactTopology } from '../../filters/downstream-error';

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
 * and internal probe details. Full detail still reaches the server-side log
 * entry in `probeService`.
 */
interface ServiceProbeResult {
  status: string;
  service: string;
  uptime_seconds?: number;
  duration_ms?: number;
  error?: string;
}

/**
 * Consolidated downstream-service health for operators.
 *
 * TASK-759 (rule P2): these two routes used to live on `ApiHealthController`
 * at `api/v1/health/services{,/:serviceKey}` — a CASL-gated administrative
 * capability sitting on the PUBLIC k8s-probe prefix. The prefix is the
 * load-bearing input to the credential-class decision, so ops telemetry gated
 * on `manage:all | read:TenantTelemetry` belongs on the admin plane. The
 * handlers, the gate, the `@ForbidApiKey()` posture and the sanitised payload
 * shape all moved across UNCHANGED — this is a re-filing, not a
 * re-authorization. `ApiHealthController` keeps only the four `@Public()`
 * probes.
 *
 * The gate is deliberately `CanAny(...)` in OR mode, not `manage:all`: a
 * TENANT_ADMIN holding `read:TenantTelemetry` reads downstream health for
 * their own tenant dashboard. The payload is already sanitised platform-infra
 * status (no PHI, no per-tenant rows); a plain DOCTOR holds neither grant and
 * is rejected.
 */
@ApiTags('health')
@ApiBearerAuth()
// Carried over from `ApiHealthController` rather than re-derived: the probe
// fans out 4-6 outbound HTTP calls per request, so it is an SSRF amplifier
// whatever the prefix. 30/min stays comfortably above the admin console's
// 30-second poll (`features/monitoring/api/hooks.ts`).
@Throttle({ default: { limit: 30, ttl: 60000 } })
@Controller('admin/health/services')
// TASK-742 API-KEY-NOTE — CONSERVATIVE DEFAULT, AWAITING OWNER CLASSIFICATION.
// Reason: downstream-service probes gated on manage:all/read:TenantTelemetry.
// Inherited verbatim from `ApiHealthController`'s class-level declaration,
// which is what covered these two routes before the TASK-759 split. Under
// TASK-757's A2 sweep the same posture is reached by a different route —
// "admin plane, therefore JWT-only" rather than "undeclared, therefore
// closed" — so this comment is expected to be replaced, not the decorator.
@ForbidApiKey()
// SVC-NOTE (TASK-773, owner decision O-1) — CLOSED to the machine class.
// This is a positive decision about the surface, not the "undeclared, therefore
// closed" default the API-key note above records. A downstream-probe fan-out is
// operator telemetry a human reads on the monitoring screen to answer "is the
// platform healthy right now" — the payload is deliberately sanitised for that
// audience and carries no rows an integration could act on. It is also a
// 4-6-call outbound SSRF amplifier (hence the throttle), which is the last
// surface to hand to a credential that can be driven in a loop. So
// deny-by-default stands and the area is deliberately absent from the generated
// SDK surface. Re-opening it is a new owner decision, not a code-review call.
@ForbidServiceAccount()
export class AdminHealthServicesController {
  private readonly logger = new Logger(AdminHealthServicesController.name);
  private readonly downstreamServices: DownstreamService[];

  constructor(
    private readonly httpService: HttpService,
    @Inject(IConfigService)
    private readonly configService: IConfigService,
  ) {
    // Downstream URLs resolve through the typed
    // `IConfigService.getConfigValue(...)` accessor; direct
    // `process.env.{TEXT,STT,NLP,...}_URL` reads are forbidden by the
    // `no-direct-downstream-url-env` lint rule. Built once per controller
    // instance — the URLs do not change at runtime.
    this.downstreamServices = [
      {
        key: 'smr',
        name: 'Summarization',
        url: this.configService.getConfigValue('TEXT_URL'),
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

  @Get()
  @CanAny(['manage', 'all'], ['read', 'TenantTelemetry'])
  @ApiOperation({ summary: 'Consolidated health check for all downstream microservices (admin only)' })
  @ApiResponse({ status: 200, description: 'Sanitised health status of SMR, NLP, STT, TTS, Guardrail, and Harness services' })
  @ApiResponse({ status: 401, description: 'Authentication required' })
  async checkServices() {
    const results = await Promise.allSettled(this.downstreamServices.map((svc) => this.probeService(svc)));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- the per-service entry is either a ServiceProbeResult or the rejected-probe shape below; a union here would buy nothing at the response boundary
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

  @Get(':serviceKey')
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
      // Full payload (including `version` and `checks`) is logged
      // server-side at debug level for operator visibility. The public
      // response shape OMITS these fields so version + downstream probe
      // details never leak to the client.
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
      // TASK-768: this is a 200 body, but it is still client-facing — it used
      // to hand the admin console `connect ECONNREFUSED 127.0.0.1:8862`. The
      // REASON is the whole point of a health screen, so the string is kept and
      // only the topology is stripped: the errno survives, the host/port/URL do
      // not. The unredacted cause remains in the operator log just above.
      return {
        status: 'down',
        service: svc.name,
        error: redactTopology(err instanceof Error ? err.message : String(err)),
      };
    }
  }
}
