import { Controller, Get, Inject, Post, Query } from '@nestjs/common';
import { ApiBearerAuth, ApiOkResponse, ApiOperation, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import { IInferenceReadinessService, InferenceReadinessResponse, toInferenceReadinessResponse } from '@arcaai/applications';
import { Authorize, ForbidApiKey, RequiredSvcScopes } from '../../decorators';
import { AiServiceProxyClient, GuardrailConfigResult } from './ai-service-proxy.client';
import { MlflowSearchQuery } from './dto/mlflow-search.query';
import { MlflowProxyClient, MlflowStatusResponse } from './mlflow-proxy.client';

/**
 * AiServiceAdminController.
 *
 * READ-ONLY status/config plane over the Guardrail and NLP Python services and
 * the MLflow tracking server, proxied through the gateway (the console never
 * reaches them directly). Platform-infrastructure tier — class-level
 * `manage:all` (SUPER_ADMIN), matching the queue/platform-metrics posture:
 * these documents expose engine, model, and infra internals, not tenant data.
 *
 * Deliberately no mutation routes: none of these backends exposes internal
 * config writes we should proxy, so the gateway does not invent them (config
 * changes are deploy-time env/settings changes on those services). For MLflow
 * that omission is load-bearing rather than incidental — `mlflow gc` is its
 * only hard-delete path and therefore its right-to-erasure mechanism
 * (; erasure belongs to the CronJob that owns it, never to
 * a console button.
 *
 * The MLflow routes join THIS controller rather than a new `admin/mlflow`
 * controller on purpose. `svc:*` scopes are DERIVED from the API-key registry
 * in `@arcaai/applications`, and boot-audit assertion D requires every admin
 * area to be covered by exactly one `svc:*` scope — so a new area would need a
 * new scope in a package this change does not own. MLflow is a read plane over
 * a platform AI service, which is precisely what this area already is.
 */
@ApiTags('admin-ai-services')
@ApiBearerAuth()
@Authorize(['manage', 'all'])
@ForbidApiKey()
@RequiredSvcScopes('svc:admin:ai-service:manage')
@Controller('admin/ai-services')
export class AiServiceAdminController {
  constructor(
    private readonly proxyClient: AiServiceProxyClient,
    private readonly mlflowClient: MlflowProxyClient,
    @Inject(IInferenceReadinessService) private readonly readinessService: IInferenceReadinessService,
  ) {}

  @Get('readiness')
  @ApiOperation({
    summary: 'Inference readiness — the platform’s last observation of every engine, service and model',
    description:
      'The stored snapshot taken by the readiness sweep: per engine (LM Studio, Ollama, vLLM, llama.cpp) its probe ' +
      'status, latency and loaded/listed counts; per HOPE service its heartbeat; per registry model a readiness state ' +
      '(`ready` / `loadable` / `engine_down` / `weights_missing` / `credential_missing` / `unknown`). ' +
      'READS NOTHING LIVE — it serves what the sweep last saw, and `checkedAt` says when that was, so an operator is ' +
      'never shown a stale answer dressed as a current one. Before the first sweep (or with the sweep switched off) ' +
      'this is an EMPTY document with `checkedAt: null`, not a 404: "nothing has been observed" is a state of the ' +
      'platform, not a missing resource. Use `POST readiness/refresh` to take an observation now.',
  })
  @ApiOkResponse({ description: 'The last readiness observation.', type: InferenceReadinessResponse })
  @ApiResponse({ status: 403, description: 'Caller is not a super admin, or presented an API key (this plane is JWT/service-account only).' })
  async readiness(): Promise<InferenceReadinessResponse> {
    return toInferenceReadinessResponse(await this.readinessService.getSnapshot());
  }

  @Post('readiness/refresh')
  // A refresh costs a real engine probe through the text service, so it carries
  // its own ceiling on top of the global default tier. The GET does not: it is
  // a Redis read.
  @Throttle({ default: { limit: 6, ttl: 60_000 } })
  @ApiOperation({
    summary: 'Take one readiness observation now',
    description:
      'Runs a single sweep immediately, ignoring the configured interval, and returns its result. Rate-limited to 6 per ' +
      'minute because each run sends a probe to the text service, which is the single aggregator in front of the ' +
      'engines. Never fails on an unreachable engine — an engine that does not answer IS the observation.',
  })
  @ApiOkResponse({ description: 'The observation just taken.', type: InferenceReadinessResponse })
  @ApiResponse({ status: 403, description: 'Caller is not a super admin, or presented an API key.' })
  @ApiResponse({ status: 429, description: 'Refresh rate limit exceeded.' })
  async refreshReadiness(): Promise<InferenceReadinessResponse> {
    return toInferenceReadinessResponse(await this.readinessService.sweep());
  }

  @Get('guardrail/status')
  @ApiOperation({
    summary: 'Guardrail service health (proxied /api/health): LLM engine, GLiNER, and Redis component checks.',
  })
  @ApiOkResponse({ description: 'Upstream guardrail health document, proxied verbatim.' })
  async guardrailStatus(): Promise<Record<string, unknown>> {
    return this.proxyClient.guardrailStatus();
  }

  @Get('guardrail/config')
  @ApiOperation({
    summary: 'Guardrail read-only configuration: medical-validation engine settings + supported analysis types.',
  })
  @ApiOkResponse({ description: 'Merged `{ medicalValidation, analysisTypes }` document from the guardrail service.' })
  async guardrailConfig(): Promise<GuardrailConfigResult> {
    return this.proxyClient.guardrailConfig();
  }

  @Get('nlp/status')
  @ApiOperation({
    summary: 'NLP service health (proxied /api/v1/health): per-model component checks with load status.',
  })
  @ApiOkResponse({ description: 'Upstream NLP health document, proxied verbatim.' })
  async nlpStatus(): Promise<Record<string, unknown>> {
    return this.proxyClient.nlpStatus();
  }

  @Get('mlflow/status')
  @ApiOperation({
    summary: 'MLflow tracking-server reachability, version and framing posture',
    description:
      'Probes the tracking server’s host-validation-exempt `/health` (and `/version` best-effort) and reports the ' +
      '`X-Frame-Options` header OBSERVED on that response, so the console can decide whether the MLflow UI may be ' +
      'embedded rather than assuming. Never fails: an unreachable server is a status document with `reachable: false`, ' +
      'because MLflow ships without an Ingress and being unreachable from the console is its normal state.',
  })
  @ApiOkResponse({ description: 'Reachability + embeddability document.', type: MlflowStatusResponse })
  @ApiResponse({ status: 403, description: 'Caller is not a super admin, or presented an API key (this plane is JWT/service-account only).' })
  async mlflowStatus(): Promise<MlflowStatusResponse> {
    return this.mlflowClient.status();
  }

  @Get('mlflow/experiments')
  @ApiOperation({
    summary: 'Search MLflow experiments',
    description: 'Proxies MLflow’s own `GET /api/2.0/mlflow/experiments/search`. Response shape is UPSTREAM-OWNED and passed through verbatim.',
  })
  @ApiOkResponse({ description: 'MLflow `SearchExperiments` response (`experiments[]`, `next_page_token`), proxied verbatim.' })
  @ApiResponse({ status: 400, description: 'Rejected query window, or MLflow’s own 400 for a malformed `filter`.' })
  @ApiResponse({ status: 503, description: 'The tracking server could not be reached.' })
  async mlflowExperiments(@Query() query: MlflowSearchQuery): Promise<Record<string, unknown>> {
    return this.mlflowClient.searchExperiments(query);
  }

  @Get('mlflow/registered-models')
  @ApiOperation({
    summary: 'Search the MLflow model registry',
    description:
      'Proxies `GET /api/2.0/mlflow/registered-models/search`. MLflow holds metadata and lineage; served weights live in the `hope-models` bucket.',
  })
  @ApiOkResponse({ description: 'MLflow `SearchRegisteredModels` response (`registered_models[]`, `next_page_token`), proxied verbatim.' })
  @ApiResponse({ status: 400, description: 'Rejected query window, or MLflow’s own 400 for a malformed `filter`.' })
  @ApiResponse({ status: 503, description: 'The tracking server could not be reached.' })
  async mlflowRegisteredModels(@Query() query: MlflowSearchQuery): Promise<Record<string, unknown>> {
    return this.mlflowClient.searchRegisteredModels(query);
  }

  @Get('mlflow/model-versions')
  @ApiOperation({
    summary: 'Search MLflow model versions',
    description:
      'Proxies `GET /api/2.0/mlflow/model-versions/search`. Aliases (not stages) are the promotion mechanism — see the registry conventions.',
  })
  @ApiOkResponse({ description: 'MLflow `SearchModelVersions` response (`model_versions[]`, `next_page_token`), proxied verbatim.' })
  @ApiResponse({ status: 400, description: 'Rejected query window, or MLflow’s own 400 for a malformed `filter`.' })
  @ApiResponse({ status: 503, description: 'The tracking server could not be reached.' })
  async mlflowModelVersions(@Query() query: MlflowSearchQuery): Promise<Record<string, unknown>> {
    return this.mlflowClient.searchModelVersions(query);
  }
}
