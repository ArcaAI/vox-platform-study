import {
  AiModelService,
  Authorize,
  HarnessPolicyService,
  IActiveUserContext,
  IAiRuntimeProfileService,
  IAiTaskDefaultService,
  IBlobStorageService,
  IConfigService,
  IDnaWritingStyleService,
  IProviderConnectionService,
  ITenantService,
  IUsageLedgerService,
  ModelResponse,
  buildLlmUsageInput,
  parseSmrUsageDetail,
  parseStorageUri,
  SecretsService,
  isSuperAdmin,
  SmrRequestEnrichmentService,
} from '@arcaai/applications';
import type { IBlobStorageService as IBlobStorageServiceType } from '@arcaai/applications';
import {
  ContextItemRepository,
  ContextItemType,
  DepartmentRepository,
  DnaWritingStyleReportRepository,
  MediaRepository,
  ModelTaskType,
  PromptTemplateRepository,
} from '@arcaai/domains';
import { HttpService } from '@nestjs/axios';
import {
  BadRequestException,
  Body,
  Controller,
  ForbiddenException,
  Get,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Logger,
  NotFoundException,
  Optional,
  Param,
  Post,
  Query,
  Res,
  UnauthorizedException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiExcludeEndpoint, ApiOperation, ApiParam, ApiTags } from '@nestjs/swagger';
import type { AxiosError } from 'axios';
import type { Response } from 'express';
import { ClsService } from 'nestjs-cls';
import { StreamScope } from '../auth/decorators/stream-scope.decorator';

interface SmrResponseFormat {
  type: 'text' | 'json' | 'json_schema';
  json_schema?: Record<string, unknown>;
  strict?: boolean;
}

interface SmrGenerateRequest {
  prompt: string;
  system_prompt?: string;
  provider?: string;
  model?: string;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  stream?: boolean;
  response_format?: SmrResponseFormat;
  context?: Record<string, unknown>;
  /**
   * Gateway-injected tenant BYO credentials, keyed by provider.
   * NEVER accepted from a client: the strict global ValidationPipe rejects
   * undeclared fields on the request DTOs, and this interface describes the
   * body as FORWARDED, after `applyTenantProviderOverrides` populates it.
   */
  provider_overrides?: Record<
    string,
    {
      api_key: string;
      base_url?: string;
      region?: string;
      api_version?: string;
      deployment_name?: string;
      model?: string;
      project?: string;
      location?: string;
      /**
       * WHO PAID for this credential: the caller tenant's own
       * connection row (`'tenant'`) or the SYSTEM-tenant platform default
       * (`'platform'`). SMR reads it to stamp `usage_detail.byok`, which
       * becomes `deployment`/`costBasis` on the ledger row.
       *
       * The entry is forwarded VERBATIM below, so this field rides the
       * existing transport with no plumbing of its own — and, being
       * per-entry, it survives a cascade that merges tenant-over-platform per
       * provider. ABSENT ⇒ `'tenant'`, which is exactly right for any sender
       * with no platform tier to draw from.
       */
      funding?: 'tenant' | 'platform';
    }
  >;
}

type VisitType = 'new_visit' | 'referral';
type GenerationType = 'pre-summary' | 'summary';

interface AssembledGenerateRequest {
  type: GenerationType;
  visit_type?: VisitType;
  context_item_ids?: string[];
  message?: string;
  prompt_template_id?: string;
  dna_writing_style_id?: string;
  provider?: string;
  model?: string;
  temperature?: number;
  max_tokens?: number;
  stream?: boolean;
  debug?: boolean;
}

interface UpstreamErrorPayload {
  detail?: string;
  message?: string;
  error_code?: string;
  [key: string]: unknown;
}

const RETRIABLE_CODES = new Set(['ECONNREFUSED', 'ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EPIPE']);
// Codes that can ONLY occur while establishing the
// connection, i.e. before any request bytes reached SMR. Everything else
// (ECONNRESET/EPIPE/ETIMEDOUT, or ANY upstream response) may mean SMR already
// started a billable generation, so the non-idempotent `/generate` POSTs must
// never retry on them (duplicate billing + divergent drafts).
const CONNECT_PHASE_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND']);
const SSE_HEARTBEAT_INTERVAL_MS = 15_000;
// Cap extracted attachment text injected into a summarization prompt so a large
// document can't blow the SMR context window. ~200k chars ≈ 50k tokens.
const ATTACHMENT_TEXT_LIMIT = 200_000;
const GLOBAL_TENANT_KEY = '__GLOBAL__';
// SUPER_ADMIN (formerly GLOBAL_ADMIN, renamed TASK-707) is the single
// elevated role; the earlier, unrelated pre-TASK-417 SUPER_ADMIN role has
// been retired.
const SUPER_ADMIN_ROLE = 'SUPER_ADMIN';

// One listing entry per registry `provider`, keeping the legacy
// response shape the console/SDK already consume (`name`/`models`/`is_available`/
// `is_default`/`default_model`); each model carries the provider-native
// identifier (`AiModel.sourceUri`) as `name` plus the stable registry `slug`.
interface ProviderListingModel {
  name: string;
  slug: string;
  size: string;
}

interface ProviderListingEntry {
  name: string;
  models: ProviderListingModel[];
  is_available: boolean;
  is_default: boolean;
  default_model?: string;
}

// The class-level `@UseGuards(JwtAuthGuard)` was removed: every
// method already carries `@Authorize()`, and the global `UnifiedAuthGuard`
// (`APP_GUARD`) authenticates (JWT + stream-ticket path) once per request. The
// redundant class guard previously made `text/*` routes run the JWT path a
// third time.
@ApiTags('text')
@ApiBearerAuth()
@Controller('text')
export class SmrProxyController {
  private readonly logger = new Logger(SmrProxyController.name);

  constructor(
    private readonly httpService: HttpService,
    @Inject(ITenantService)
    private readonly tenantService: ITenantService,
    private readonly clsService: ClsService<IActiveUserContext>,
    private readonly contextItemRepository: ContextItemRepository,
    private readonly promptTemplateRepository: PromptTemplateRepository,
    private readonly dnaWritingStyleRepository: DnaWritingStyleReportRepository,
    private readonly departmentRepository: DepartmentRepository,
    private readonly mediaRepository: MediaRepository,
    @Inject(IBlobStorageService) private readonly blobStorage: IBlobStorageServiceType,
    @Inject(IConfigService) private readonly configService: IConfigService,
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
    // Resolves the tenant's effective SMR {provider, model} when a
    // caller (playground/SDK) omits the model. @Optional so test fixtures that
    // construct the controller without it keep compiling.
    @Optional() @Inject(HarnessPolicyService) private readonly harnessPolicyService?: HarnessPolicyService,
    // The providers listings read the AiModel registry (the single
    // UI catalog) through the SHARED-READ query: visibility
    // is [caller tenant, SYSTEM] de-duplicated by slug, tenant clone wins.
    // @Optional so existing positional test fixtures keep compiling.
    @Optional() @Inject(AiModelService) private readonly aiModelService?: AiModelService,
    // Resolves the effective `guardrail.validate` default for the
    // guardrail listing's default marking.
    @Optional() @Inject(IAiTaskDefaultService) private readonly aiTaskDefaultService?: IAiTaskDefaultService,
    // Resolves the effective hyperparameter profile for the outgoing
    // {provider, model}. @Optional so existing positional test fixtures (and
    // graphs that never proxy to SMR) keep compiling.
    @Optional()
    @Inject(IAiRuntimeProfileService)
    private readonly aiRuntimeProfileService?: IAiRuntimeProfileService,
    // Resolves the caller tenant's BYO cloud credential for the
    // outgoing provider. @Optional so existing positional test fixtures (and
    // graphs that never proxy to SMR) keep compiling.
    @Optional()
    @Inject(IProviderConnectionService)
    private readonly aiProviderConnectionService?: IProviderConnectionService,
    // Records the tokens a proxied stream consumed, on
    // teardown. @Optional so existing positional test fixtures keep compiling;
    // absent ⇒ the stream is simply not metered (it is never failed).
    @Optional()
    @Inject(IUsageLedgerService)
    private readonly usageLedger?: IUsageLedgerService,
    // TASK-700: the gated accessor for a doctor's effective DNA writing-style
    // text (tenant+doctor opt-out gate, latest report, decrypt). @Optional so
    // existing positional test fixtures keep compiling; absent ⇒ no style is
    // injected (matches the general fail-open-but-additive DNA posture).
    @Optional()
    @Inject(IDnaWritingStyleService)
    private readonly dnaWritingStyleService?: IDnaWritingStyleService,
  ) {
    // BUG-018 — the two enrichment steps now live in ONE applications-layer
    // service shared with the prompt-template test bench. Constructed here from
    // this controller's own (already injected) dependencies rather than taken as
    // another constructor parameter: the service is stateless, and every
    // existing positional test fixture keeps its arity and its exact behavior.
    this.smrRequestEnrichment = new SmrRequestEnrichmentService(this.clsService, this.aiRuntimeProfileService, this.aiProviderConnectionService);
  }

  private readonly smrRequestEnrichment: SmrRequestEnrichmentService;

  /**
   * SDK fidelity: a caller-supplied model is forwarded
   * untouched. When the model is absent, resolve SYSTEM `{provider, model}` via
   * AiTaskDefault / HarnessPolicy. FAIL CLOSED: unresolved selection rethrows
   * (typically 400) — no silent omit → env fallback.
   */
  private async applySmrModelSelection<T extends { provider?: string; model?: string }>(target: T): Promise<T> {
    if (!target.model && this.harnessPolicyService) {
      const tenantId = this.clsService.get('tenantId');
      const { provider, model } = await this.harnessPolicyService.resolveSmrSelection(tenantId);
      target.provider = provider;
      target.model = model;
    }
    // Layer the resolved runtime profile on top of the identity.
    // Runs for a caller-pinned model too: the caller chose the MODEL, not the
    // hyperparameters, and any parameter they did send still wins below.
    await this.applySmrRuntimeProfile(target);
    // Then fold in the caller tenant's BYO cloud credential, if any.
    return this.applyTenantProviderOverrides(target);
  }

  /**
   * Fold the caller tenant's BYO cloud credential into the forwarded body as
   * `provider_overrides`.
   *
   * BUG-018 — the implementation MOVED VERBATIM to the applications-layer
   * `SmrRequestEnrichmentService` so the prompt-template test bench (which used
   * to POST to SMR directly, on platform credentials) shares exactly one
   * implementation with this proxy. Semantics are unchanged: cloud-only,
   * minimal exposure, fail-open on a resolver error, and the policy-refusal
   * `assertProviderAvailable` check outside that catch.
   */
  private async applyTenantProviderOverrides<T extends { provider?: string }>(target: T): Promise<T> {
    return this.smrRequestEnrichment.applyTenantProviderOverrides(target);
  }

  /**
   * Inject the resolved hyperparameter profile into the forwarded body.
   *
   * BUG-018 — implementation MOVED VERBATIM to `SmrRequestEnrichmentService`
   * (caller-wins merge, fail-open on resolver error). See above.
   */
  private async applySmrRuntimeProfile<T extends { provider?: string; model?: string }>(target: T): Promise<T> {
    return this.smrRequestEnrichment.applySmrRuntimeProfile(target);
  }

  // The SMR base URL resolves through the
  // typed `IConfigService.getConfigValue('TEXT_URL')` accessor. A direct
  // `process.env.TEXT_URL || 'http://localhost:8862'`
  // read is forbidden by the `no-direct-downstream-url-env` lint
  // rule; the env-or-fallback resolution happens once at bootstrap
  // in `ConfigService.loadBaseConfig()`.
  private getSmrBaseUrl(): string {
    return this.configService.getConfigValue('TEXT_URL');
  }

  private getForwardHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    // Sync lookup against the cache warmed at
    // bootstrap. Same fail-open behavior on miss (no header set) we had
    // when the env var was unset.
    const serviceToken = this.secretsService?.getSecretSync('TEXT_SERVICE_TOKEN');
    if (serviceToken) {
      headers['X-Service-Token'] = serviceToken;
    }
    return headers;
  }

  private isRetriable(err: unknown): boolean {
    const code = (err as AxiosError)?.code;
    if (code && RETRIABLE_CODES.has(code)) return true;
    const status = (err as AxiosError)?.response?.status;
    return status === 502 || status === 503 || status === 504;
  }

  /**
   * Retry predicate for the NON-IDEMPOTENT `/generate` POSTs:
   * only connect-phase failures qualify, because they prove the request never
   * left the gateway. An upstream response (any status) or a post-send socket
   * failure means SMR may already be generating — retrying would re-invoke it.
   */
  private isConnectPhaseFailure(err: unknown): boolean {
    const axiosError = err as AxiosError;
    if (axiosError?.response) return false; // upstream responded → request was delivered
    const code = axiosError?.code;
    return typeof code === 'string' && CONNECT_PHASE_CODES.has(code);
  }

  private buildUpstreamException(err: unknown, fallbackMessage: string): HttpException {
    const axiosError = err as AxiosError<UpstreamErrorPayload | string>;
    const status = axiosError.response?.status;
    const payload = axiosError.response?.data;

    // The raw upstream error body can echo the assembled
    // clinical prompt / PHI or internal SMR/LM-Studio stack detail. It MUST NOT
    // reach the client AND MUST NOT be written to logs (stdout → k8s/Loki, outside
    // PHI controls). Record only NON-CONTENT metadata — the upstream status, the
    // request correlation id, and an explicit redaction sentinel — so operators can
    // correlate the failure without the body ever landing in telemetry. Return a
    // GENERIC message; the status-code mapping is preserved (the semantic lives in
    // the status, not the body). This replaces both former verbatim-forward
    // branches AND the earlier interim fix that logged the raw body.
    if (payload !== undefined && payload !== null && payload !== '') {
      this.logger.error({
        message: 'SMR upstream error (body redacted — may contain PHI/prompt content)',
        upstreamStatus: status,
        correlationId: this.clsService.getId(),
        upstreamBodyRedacted: true,
      });
    }

    if (typeof status === 'number') {
      return new HttpException({ detail: fallbackMessage }, status);
    }

    return new HttpException({ detail: fallbackMessage }, HttpStatus.BAD_GATEWAY);
  }

  private async withRetry<T>(
    fn: () => Promise<T>,
    context: string,
    maxRetries = 2,
    // Non-idempotent calls narrow this to connect-phase-only.
    isRetriable: (err: unknown) => boolean = (err) => this.isRetriable(err),
  ): Promise<T> {
    let lastErr: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        return await fn();
      } catch (err) {
        lastErr = err;
        if (attempt < maxRetries && isRetriable(err)) {
          const delayMs = Math.min(1000 * Math.pow(2, attempt), 4000);
          this.logger.warn({
            message: `Retrying ${context}`,
            attempt: attempt + 1,
            maxRetries,
            delayMs,
            error: err instanceof Error ? err.message : String(err),
          });
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }
        break;
      }
    }
    throw lastErr;
  }

  /**
   * The GLOBAL-tenant fallback used
   * to fire implicitly whenever a SUPER_ADMIN happened to have no CLS
   * tenantId. That made it easy for a SUPER_ADMIN debugging an issue
   * to accidentally read or mutate __GLOBAL__ provider settings while
   * trying to inspect a tenant. The fallback is now EXPLICIT: callers
   * pass `?tenantKey=__GLOBAL__`, and only SUPER_ADMINs may do so.
   * Any other tenantKey value is a BadRequest (we never want a caller
   * to spell another tenant's id into this controller).
   */
  private async resolveTenantId(tenantKey?: string): Promise<string> {
    if (tenantKey !== undefined && tenantKey !== '') {
      if (tenantKey !== GLOBAL_TENANT_KEY) {
        throw new BadRequestException(`Only the literal '${GLOBAL_TENANT_KEY}' is accepted as a tenantKey override`);
      }
      const user = this.clsService.get('user');
      if (!isSuperAdmin(user)) {
        throw new ForbiddenException(`Only ${SUPER_ADMIN_ROLE} may use ?tenantKey=${GLOBAL_TENANT_KEY}`);
      }
      const globalTenant = await this.tenantService.fetchByCodeName(GLOBAL_TENANT_KEY);
      return globalTenant.id;
    }

    const tenantId = this.clsService.get('tenantId');
    if (tenantId) return tenantId;

    throw new UnauthorizedException('No tenant context available');
  }

  /**
   * Read the registry rows backing a providers listing.
   *
   * `getByTaskType` pins the
   * CLS tenant explicitly and therefore DEFEATS the SYSTEM-shared-read
   * widening (tenants without cloned rows got an empty listing). The
   * shared-read variant queries without a tenant pin so the extension widens
   * visibility to [caller tenant, SYSTEM], de-duplicated by slug with the
   * tenant clone preferred (ENABLED-only either way). FAILS OPEN to zero rows
   * — a registry read problem must degrade the LISTING (probe fallback /
   * empty), never 5xx the console.
   */
  private async fetchRegistryModels(taskTypes: ModelTaskType[]): Promise<ModelResponse[]> {
    if (!this.aiModelService) return [];
    try {
      const lists = await Promise.all(taskTypes.map((taskType) => this.aiModelService!.getByTaskTypeSharedRead(taskType)));
      const seen = new Set<string>();
      const rows: ModelResponse[] = [];
      for (const row of lists.flat()) {
        if (seen.has(row.id)) continue; // a row can carry both listed task types
        seen.add(row.id);
        rows.push(row);
      }
      return rows;
    } catch (err) {
      this.logger.warn({
        message: 'AiModel registry read failed for providers listing; treating as empty',
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  /**
   * Group registry rows by `provider` into the legacy listing shape.
   * Rows without a `provider` are skipped (not yet machine-actionable — the
   * pre-506 catalog rows); `defaultSelection` marks the tenant's effective
   * default provider/model (HarnessPolicy for SMR, AiTaskDefault for guardrail).
   */
  private groupRegistryModelsByProvider(
    rows: ModelResponse[],
    defaultSelection?: { provider?: string | null; model?: string | null },
  ): ProviderListingEntry[] {
    const groups = new Map<string, ProviderListingModel[]>();
    for (const row of rows) {
      const provider = row.provider?.trim();
      if (!provider) continue;
      const models = groups.get(provider) ?? [];
      models.push({ name: row.sourceUri, slug: row.slug, size: this.formatModelSize(row.memorySizeMb) });
      groups.set(provider, models);
    }
    return [...groups.entries()].map(([provider, models]) => {
      const isDefault = provider === defaultSelection?.provider;
      return {
        name: provider,
        models,
        is_available: true,
        is_default: isDefault,
        // Mirrors the legacy shape: the default provider surfaces the selected
        // model; other providers surface their first model.
        default_model: isDefault ? (defaultSelection?.model ?? models[0]?.name) : models[0]?.name,
      };
    });
  }

  /** `memorySizeMb` → the human string the legacy catalog carried ('4.8 GB' / '900 MB' / ''). */
  private formatModelSize(memorySizeMb: number | null | undefined): string {
    if (typeof memorySizeMb !== 'number' || !Number.isFinite(memorySizeMb) || memorySizeMb <= 0) return '';
    return memorySizeMb >= 1024 ? `${(memorySizeMb / 1024).toFixed(1)} GB` : `${memorySizeMb} MB`;
  }

  @Post('generate')
  @HttpCode(HttpStatus.OK)
  @Authorize()
  @ApiExcludeEndpoint()
  @ApiOperation({ summary: 'Generate text via SMR (sync or streaming)' })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async generate(@Body() body: SmrGenerateRequest): Promise<any> {
    const base = this.getSmrBaseUrl();
    await this.applySmrModelSelection(body);

    try {
      const response = await this.withRetry(
        () =>
          this.httpService.axiosRef.post(`${base}/api/v1/generate`, body, {
            headers: this.getForwardHeaders(),
            timeout: body.stream ? 30_000 : 120_000,
          }),
        'SMR generate',
        // /generate is non-idempotent (billable generation):
        // retry ONLY when the request provably never reached SMR.
        2,
        (err) => this.isConnectPhaseFailure(err),
      );

      return response.data;
    } catch (err) {
      const upstreamStatus = (err as AxiosError)?.response?.status;
      this.logger.error({
        message: 'Failed to proxy generate request to SMR',
        error: err instanceof Error ? err.message : String(err),
        code: (err as AxiosError)?.code,
        upstreamStatus,
      });
      throw this.buildUpstreamException(err, 'SMR service unavailable');
    }
  }

  @Get('tasks/:taskId')
  @Authorize()
  @ApiOperation({ summary: 'Get task status from SMR' })
  @ApiParam({ name: 'taskId', description: 'Task ID' })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getTaskStatus(@Param('taskId') taskId: string): Promise<any> {
    const base = this.getSmrBaseUrl();

    try {
      const response = await this.withRetry(
        () =>
          this.httpService.axiosRef.get(`${base}/api/v1/tasks/${taskId}`, {
            headers: this.getForwardHeaders(),
          }),
        `SMR task status ${taskId}`,
      );

      return response.data;
    } catch (err) {
      const upstreamStatus = (err as AxiosError)?.response?.status;
      this.logger.error({
        message: 'Failed to get task status from SMR',
        taskId,
        error: err instanceof Error ? err.message : String(err),
        upstreamStatus,
      });
      throw this.buildUpstreamException(err, 'SMR service unavailable');
    }
  }

  @Post('tasks/:taskId/cancel')
  @Authorize()
  @ApiOperation({ summary: 'Cancel a running SMR task' })
  @ApiParam({ name: 'taskId', description: 'Task ID to cancel' })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async cancelTask(@Param('taskId') taskId: string): Promise<any> {
    const base = this.getSmrBaseUrl();

    try {
      const response = await this.httpService.axiosRef.post(`${base}/api/v1/tasks/${taskId}/cancel`, {}, { headers: this.getForwardHeaders() });

      return response.data;
    } catch (err) {
      const upstreamStatus = (err as AxiosError)?.response?.status;
      this.logger.error({
        message: 'Failed to cancel SMR task',
        taskId,
        error: err instanceof Error ? err.message : String(err),
        upstreamStatus,
      });
      throw this.buildUpstreamException(err, 'SMR service unavailable');
    }
  }

  @Get('tasks/:taskId/stream')
  @Authorize()
  @StreamScope({ namespace: 'smr_task', param: 'taskId' })
  @ApiOperation({
    summary: 'Stream task chunks via SSE from SMR',
    description:
      'Server-Sent Events stream. Accepts either `Authorization: Bearer <jwt>` or a single-use `?ticket=<ticket>` issued by `POST /auth/stream-ticket` with scope `smr_task:<taskId>`.',
  })
  @ApiParam({ name: 'taskId', description: 'Task ID to stream' })
  async streamTaskEvents(
    @Param('taskId') taskId: string,
    @Headers('last-event-id') lastEventId: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const base = this.getSmrBaseUrl();

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

    // Meter what flows through the pipe.
    //
    // The proxy stays a byte pipe: every chunk is forwarded VERBATIM and the
    // usage block is read from a side copy. `usageTail` holds only the bytes
    // after the last complete frame boundary, so memory does not grow with the
    // length of a long generation.
    const tenantId = this.clsService.get('tenantId');
    let usageTail = '';
    let terminalUsage: unknown = null;
    let emitted = false;

    // Teardown fires from three places (`end`, `error`, client `close`) and can
    // fire more than once. Emission is idempotent at the ledger anyway — the
    // key is derived from the task id — but emitting once keeps the outbox from
    // absorbing three copies of every stream.
    const emitUsageOnce = (): void => {
      if (emitted) return;
      emitted = true;
      if (!this.usageLedger || !tenantId || !terminalUsage) return;

      const usage = parseSmrUsageDetail(terminalUsage);
      if (!usage) return;

      const input = buildLlmUsageInput({ usage, tenantId, operation: 'generate.stream' });
      if (!input) return;

      // Fire-and-forget with a swallowed rejection: the generation already
      // happened and the client already has its bytes. A metering failure must
      // degrade to "not metered", never to a broken stream.
      void this.usageLedger.recordUsage(input).catch((error: unknown) => {
        this.logger.warn({
          message: 'Usage metering failed for a proxied SMR stream',
          taskId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    };

    /**
     * Scan forwarded bytes for the terminal frame's `usage` block.
     *
     * Only complete `\n\n`-delimited frames are parsed, and only the ones whose
     * payload carries a `usage` key — a token chunk never gets JSON-parsed, and
     * frame content is never logged (it is generated clinical text).
     */
    const captureTerminalUsage = (chunk: Buffer): void => {
      usageTail += chunk.toString('utf-8');
      let boundary = usageTail.indexOf('\n\n');
      while (boundary !== -1) {
        const frame = usageTail.slice(0, boundary);
        usageTail = usageTail.slice(boundary + 2);
        const dataLine = frame.split('\n').find((line) => line.startsWith('data:'));
        if (dataLine && dataLine.includes('"usage"')) {
          try {
            const payload = JSON.parse(dataLine.slice('data:'.length).trim()) as { data?: { usage?: unknown } };
            if (payload?.data?.usage) terminalUsage = payload.data.usage;
          } catch {
            // A partially-delivered or non-JSON frame is not worth a log line
            // (and its body may be PHI) — the next frame may still carry usage.
          }
        }
        boundary = usageTail.indexOf('\n\n');
      }
      // Bound the carry-over: a frame this large is malformed, and holding it
      // would turn a metering nicety into a memory leak.
      if (usageTail.length > 64_000) usageTail = '';
    };

    try {
      const streamUrl = lastEventId
        ? `${base}/api/v1/tasks/${taskId}/stream?last_event_id=${encodeURIComponent(lastEventId)}`
        : `${base}/api/v1/tasks/${taskId}/stream`;
      const upstream = await this.httpService.axiosRef.get(streamUrl, {
        headers: { ...this.getForwardHeaders(), Accept: 'text/event-stream' },
        responseType: 'stream',
        timeout: 300_000,
      });

      const stream = upstream.data;

      heartbeatTimer = setInterval(() => {
        if (!res.writableEnded) {
          res.write(':keepalive\n\n');
        }
      }, SSE_HEARTBEAT_INTERVAL_MS);

      stream.on('data', (chunk: Buffer) => {
        res.write(chunk);
        captureTerminalUsage(chunk);
      });

      stream.on('end', () => {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        emitUsageOnce();
        res.end();
      });

      stream.on('error', (err: Error) => {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        // The tokens seen before the socket died were still spent — emit them
        // (: this is where a dropped tail becomes lost revenue).
        emitUsageOnce();
        this.logger.error({
          message: 'SSE stream error from SMR',
          taskId,
          error: err.message,
        });
        res.end();
      });

      res.on('close', () => {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        // The client hung up. SMR keeps generating in its background task, but
        // whatever usage already crossed the wire is real and must be recorded.
        emitUsageOnce();
        stream.destroy();
      });
    } catch (err) {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      const axiosError = err as AxiosError<UpstreamErrorPayload | string>;
      const upstreamStatus = axiosError.response?.status;
      this.logger.error({
        message: 'Failed to connect to SMR SSE stream',
        taskId,
        error: err instanceof Error ? err.message : String(err),
        upstreamStatus,
      });
      // This branch is currently DEAD (flushHeaders() above
      // already sent the SSE headers, so res.headersSent is always true here and
      // only res.end() runs). Even so, NEVER forward the raw upstream body: if the
      // headers were somehow not yet sent, respond with a GENERIC message + the
      // preserved status (mirroring buildUpstreamException). This neutralizes the
      // latent PHI/prompt-echo footgun the former verbatim `res.json(payload)`
      // branches represented (they would go live if flushHeaders ever moved into
      // the try). The `res.end()` behavior on the live path is unchanged.
      if (!res.headersSent) {
        const status = typeof upstreamStatus === 'number' ? upstreamStatus : HttpStatus.BAD_GATEWAY;
        res.status(status).json({ detail: 'SMR service unavailable' });
      } else {
        res.end();
      }
    }
  }

  @Post('generate/assembled')
  @Authorize()
  @ApiOperation({ summary: 'Generate text with server-side prompt assembly (debug mode)' })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async generateAssembled(@Body() body: AssembledGenerateRequest): Promise<any> {
    this.validateAssembledRequest(body);
    this.requireDebugAccess(body.debug);

    const { prompt, systemPrompt, resolvedMeta } = await this.assemblePrompt(body);

    const smrPayload: SmrGenerateRequest = {
      prompt,
      system_prompt: systemPrompt,
      provider: body.provider,
      model: body.model,
      temperature: body.temperature,
      max_tokens: body.max_tokens,
      stream: body.stream ?? false,
    };
    await this.applySmrModelSelection(smrPayload);

    const base = this.getSmrBaseUrl();

    try {
      const response = await this.withRetry(
        () =>
          this.httpService.axiosRef.post(`${base}/api/v1/generate`, smrPayload, {
            headers: this.getForwardHeaders(),
            timeout: smrPayload.stream ? 30_000 : 120_000,
          }),
        'SMR assembled generate',
        // Same single-delivery contract as `generate()`.
        2,
        (err) => this.isConnectPhaseFailure(err),
      );

      return {
        ...response.data,
        _debug: {
          assembled: true,
          type: body.type,
          visit_type: body.visit_type,
          prompt_template_id: resolvedMeta.promptTemplateId,
          prompt_template_name: resolvedMeta.promptTemplateName,
          dna_writing_style_id: resolvedMeta.dnaStyleId,
          context_item_ids: body.context_item_ids,
          prompt_length: prompt.length,
          system_prompt_length: systemPrompt.length,
        },
      };
    } catch (err) {
      const upstreamStatus = (err as AxiosError)?.response?.status;
      this.logger.error({
        message: 'Failed to proxy assembled generate request to SMR',
        error: err instanceof Error ? err.message : String(err),
        code: (err as AxiosError)?.code,
        upstreamStatus,
      });
      throw this.buildUpstreamException(err, 'SMR service unavailable');
    }
  }

  private validateAssembledRequest(body: AssembledGenerateRequest): void {
    if (!body.type || !['pre-summary', 'summary'].includes(body.type)) {
      throw new BadRequestException('type must be "pre-summary" or "summary"');
    }
    if (!body.context_item_ids && !body.message) {
      throw new BadRequestException('Either context_item_ids or message is required');
    }
    if (body.context_item_ids && body.message) {
      throw new BadRequestException('Provide either context_item_ids or message, not both');
    }
    if (body.context_item_ids && body.context_item_ids.length === 0) {
      throw new BadRequestException('context_item_ids must not be empty');
    }
    if (body.visit_type && !['new_visit', 'referral'].includes(body.visit_type)) {
      throw new BadRequestException('visit_type must be "new_visit" or "referral"');
    }
  }

  private requireDebugAccess(debug?: boolean): void {
    if (!debug) return;

    const user = this.clsService.get('user') as { roles?: string[] } | undefined;
    const roles = user?.roles ?? [];
    const hasAdminAccess = roles.some((r) => [SUPER_ADMIN_ROLE, 'TENANT_ADMIN'].includes(r));

    if (!hasAdminAccess) {
      throw new ForbiddenException('Debug mode requires SUPER_ADMIN or TENANT_ADMIN role');
    }
  }

  private async assemblePrompt(body: AssembledGenerateRequest): Promise<{
    prompt: string;
    systemPrompt: string;
    resolvedMeta: {
      promptTemplateId?: string;
      promptTemplateName?: string;
      dnaStyleId?: string;
    };
  }> {
    const TYPE_LABEL_MAP: Record<string, string> = {
      TRANSCRIPT: 'Transcript',
      CASE_NOTE: 'Case Note',
      WORKNOTE: 'Work Note',
      RAW_SUMMARY: 'Summary',
      MODIFIED_SUMMARY: 'Edited Summary',
      PRE_SUMMARY: 'Pre-Summary',
      ATTACHMENT: 'Attachment',
      // AUDIO_RECORDING: 'Audio',
    };

    const callerTenantId = this.clsService.get('tenantId');

    let context: string;
    if (body.context_item_ids) {
      const contentBlocks: string[] = [];
      for (const id of body.context_item_ids) {
        const contextItem = await this.contextItemRepository.findById(id);
        if (!contextItem) {
          throw new NotFoundException(`Context item ${id} not found`);
        }
        // Cross-tenant context ownership check. The assembled
        // generation path assembles prompts on behalf of the caller; without
        // this guard a caller could reference another tenant's context items
        // (raw DNA / transcripts / summaries) and exfiltrate their content
        // through the generated summary. Mirror the tenant checks used in the
        // application layer (assertParentInScope) and surface a 404 so the
        // existence of cross-tenant resources is never leaked.
        const itemTenant = (contextItem as { tenantId?: string | null }).tenantId ?? null;
        if (callerTenantId && itemTenant !== null && itemTenant !== callerTenantId) {
          this.logger.warn({
            message: 'Cross-tenant context item usage rejected',
            callerTenant: callerTenantId,
            contextItemId: id,
            itemTenant,
          });
          throw new NotFoundException(`Context item ${id} not found`);
        }
        const label = TYPE_LABEL_MAP[contextItem.type] ?? 'Context';
        if (contextItem.content) {
          contentBlocks.push(`${label}:\n${contextItem.content}`);
        }
        // ATTACHMENT items reference an uploaded file (mediaId) rather than
        // inline text — fetch it from object storage and extract its text so
        // SMR (which is text-in/text-out) can summarize the document.
        if (contextItem.type === ContextItemType.ATTACHMENT && contextItem.mediaId) {
          const attachment = await this.extractAttachmentText(contextItem.mediaId);
          if (attachment) {
            contentBlocks.push(`${label} (${attachment.name}):\n${attachment.text}`);
          }
        }
      }
      if (contentBlocks.length === 0) {
        throw new BadRequestException('None of the provided context items have content');
      }
      context = contentBlocks.join('\n\n');
    } else {
      context = body.message!;
    }

    let systemPrompt = '';
    let promptTemplateId: string | undefined;
    let promptTemplateName: string | undefined;

    if (body.prompt_template_id) {
      const template = await this.promptTemplateRepository.findById(body.prompt_template_id);
      if (!template) {
        throw new NotFoundException(`Prompt template ${body.prompt_template_id} not found`);
      }

      // Close the prompt-template ownership bypass. This
      // branch previously resolved any `findById` hit with no tenant/owner
      // check (unlike the DNA guard below), so a caller could fold another
      // tenant's template — or a peer's USER_PERSONAL template in the same
      // tenant — into the system prompt. Mirror the DNA guard:
      //   1. tenant must match (NotFound on mismatch — never leak existence);
      //   2. a USER_PERSONAL template must be owned by the caller (Forbidden).
      // Tenant-less (global/system) templates keep `tenantId === null` and are
      // intentionally allowed, matching the cross-tenant context-item guard.
      const user = this.clsService.get('user') as { id?: string } | undefined;
      const callerId = user?.id;
      const templateTenant = (template as { tenantId?: string | null }).tenantId ?? null;
      const templateScope = (template as { scope?: string | null }).scope ?? null;
      const templateOwner = (template as { ownerUserId?: string | null }).ownerUserId ?? null;

      if (callerTenantId && templateTenant !== null && templateTenant !== callerTenantId) {
        this.logger.warn({
          message: 'Cross-tenant prompt template usage rejected',
          callerTenant: callerTenantId,
          promptTemplateId: template.id,
          templateTenant,
        });
        throw new NotFoundException(`Prompt template ${body.prompt_template_id} not found`);
      }

      if (templateScope === 'USER_PERSONAL' && templateOwner !== callerId) {
        this.logger.warn({
          message: 'Cross-doctor personal prompt template usage rejected',
          callerId,
          callerTenant: callerTenantId,
          promptTemplateId: template.id,
          templateOwner,
        });
        throw new ForbiddenException('You do not have access to this prompt template');
      }

      systemPrompt = template.content ?? '';
      promptTemplateId = template.id;
      promptTemplateName = template.name;
    } else {
      systemPrompt =
        body.type === 'pre-summary'
          ? 'You are a medical documentation assistant. Generate a concise pre-summary from the provided clinical context. Focus on key findings, diagnoses, medications, and treatment plans.'
          : 'You are a medical documentation assistant. Generate a comprehensive clinical summary from the provided transcript and context.';
    }

    if (body.dna_writing_style_id) {
      const dnaStyle = await this.dnaWritingStyleRepository.findById(body.dna_writing_style_id);
      // Cross-doctor DNA writing-style ownership check.
      // The SMR proxy assembles prompts on behalf of the caller; without
      // this guard a doctor could reference another doctor's stylistic
      // fingerprint (or a style from a different tenant) to imitate them.
      if (!dnaStyle) {
        throw new NotFoundException(`DNA writing style ${body.dna_writing_style_id} not found`);
      }
      const user = this.clsService.get('user') as { id?: string } | undefined;
      const tenantId = this.clsService.get('tenantId');
      const callerId = user?.id;
      const styleOwner = (dnaStyle as { doctorId?: string | null }).doctorId ?? null;
      const styleTenant = (dnaStyle as { tenantId?: string | null }).tenantId ?? null;

      if (!callerId || styleOwner !== callerId || (styleTenant !== null && tenantId && styleTenant !== tenantId)) {
        this.logger.warn({
          message: 'Cross-doctor DNA style usage rejected',
          callerId,
          callerTenant: tenantId,
          dnaStyleId: dnaStyle.id,
          styleOwner,
          styleTenant,
        });
        throw new ForbiddenException('You do not have access to this DNA writing style');
      }

      // The ownership check above only proves the referenced report belongs
      // to the caller — it must NOT be the source of the injected text. Route
      // through the same gated accessor `smr-compat` uses
      // (`IDnaWritingStyleService.getEffectiveStyleText`): it re-applies the
      // tenant+doctor opt-out gate, resolves the doctor's LATEST report, and
      // decrypts the ciphertext column. Reading `dnaStyle.styleText` directly
      // from the repository row bypassed all of that (the column is
      // ciphertext-only, so the field is never populated by a raw findById,
      // and — more importantly — a doctor who opted out after generating this
      // report would still have had it injected).
      const effectiveStyleText = await this.dnaWritingStyleService?.getEffectiveStyleText(callerId, tenantId ?? undefined);
      if (effectiveStyleText) {
        systemPrompt += `\n\nApply the following writing style:\n${effectiveStyleText}`;
      }
    }

    if (body.visit_type) {
      const visitLabel = body.visit_type === 'new_visit' ? 'new patient visit' : 'referral visit';
      systemPrompt += `\n\nThis is a ${visitLabel}.`;
    }

    const typeLabel = body.type === 'pre-summary' ? 'pre-summary' : 'clinical summary';
    const prompt = `Generate a ${typeLabel} from the following:\n\n${context}`;

    return {
      prompt,
      systemPrompt,
      resolvedMeta: {
        promptTemplateId,
        promptTemplateName,
        dnaStyleId: body.dna_writing_style_id,
      },
    };
  }

  /**
   * Resolve an ATTACHMENT context item's stored file and extract its text for
   * summarization. Returns `null` (and logs) on any non-fatal problem — a single
   * unreadable attachment must not fail the whole generation request.
   */
  private async extractAttachmentText(mediaId: string): Promise<{ name: string; text: string } | null> {
    const media = await this.mediaRepository.findById(mediaId).catch(() => null);
    if (!media) {
      this.logger.warn({ message: 'Attachment media not found; skipping', mediaId });
      return null;
    }

    const location = parseStorageUri(media.uri);
    if (!location) {
      this.logger.warn({ message: 'Unparseable media URI; skipping attachment', mediaId, uri: media.uri });
      return null;
    }

    let buffer: Buffer;
    try {
      buffer = await this.blobStorage.getObject({ bucket: location.bucket, key: location.key });
    } catch (err) {
      this.logger.warn({
        message: 'Failed to fetch attachment from storage; skipping',
        mediaId,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }

    const text = await this.extractTextFromBuffer(buffer, media.mimeType, media.name);
    if (!text || text.trim().length === 0) {
      return null;
    }

    const trimmed = text.length > ATTACHMENT_TEXT_LIMIT ? `${text.slice(0, ATTACHMENT_TEXT_LIMIT)}\n…[truncated]` : text;
    return { name: media.name, text: trimmed };
  }

  /**
   * Extract plain text from an attachment buffer by MIME type. Pluggable: text
   * formats are decoded directly (no dependency), PDFs go through `pdf-parse`.
   * Image OCR / Office formats are intentionally deferred — they return `null`
   * (skipped) rather than throwing.
   */
  private async extractTextFromBuffer(buffer: Buffer, mimeType: string, name: string): Promise<string | null> {
    const mime = (mimeType ?? '').toLowerCase();

    if (
      mime.startsWith('text/') ||
      mime === 'application/json' ||
      mime === 'application/xml' ||
      mime === 'application/x-ndjson' ||
      mime === 'application/csv'
    ) {
      return buffer.toString('utf-8');
    }

    if (mime === 'application/pdf') {
      try {
        // pdf-parse v2 replaced the callable default export with the PDFParse class.
        const { PDFParse } = await import('pdf-parse');
        const parser = new PDFParse({ data: new Uint8Array(buffer) });
        try {
          const parsed = await parser.getText();
          return parsed.text;
        } finally {
          await parser.destroy();
        }
      } catch (err) {
        this.logger.warn({
          message: 'PDF text extraction failed; skipping attachment',
          name,
          error: err instanceof Error ? err.message : String(err),
        });
        return null;
      }
    }

    this.logger.warn({ message: 'Unsupported attachment type for summarization; skipping', name, mimeType });
    return null;
  }

  // The listing reads the AiModel registry (ENABLED
  // TEXT_GENERATION + SUMMARIZATION rows grouped by `provider`), replacing the
  // retired `smr-provider-models`/`default-smr-*` GlobalSetting keys. The
  // tenant's effective default still comes from the HarnessPolicy cascade
  // (`applySmrModelSelection` untouched). The live SMR probe survives ONLY as
  // transition safety when the registry has zero rows.
  //
  // That fallback is scoped to the PLAYGROUND (tier 50-59), the
  // only surface reaching it. Governing admin surfaces must NOT infer engine
  // state from this route: the AI-models hub calls
  // `GET admin/ai-models/discovery` instead, which merges the registry with the
  // live listing and tags each entry registered / discovered /
  // registered-missing-on-server without ever mutating a row.
  @Get('providers')
  @Authorize()
  @ApiOperation({
    summary:
      'List LLM providers/models from the AiModel registry (ENABLED TEXT_GENERATION/SUMMARIZATION rows), with a live SMR probe ' +
      `fallback when the registry is empty. SUPER_ADMINs may explicitly target the GLOBAL tenant with ?tenantKey=${GLOBAL_TENANT_KEY}.`,
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getProviders(@Query('tenantKey') tenantKey?: string): Promise<any[]> {
    const tenantId = await this.resolveTenantId(tenantKey);
    const rows = await this.fetchRegistryModels([ModelTaskType.TEXT_GENERATION, ModelTaskType.SUMMARIZATION]);

    // Default marking from the tenant's effective SMR selection; fail-open (no
    // default marked) when the cascade is unresolved.
    let defaultSelection: { provider: string; model: string } | undefined;
    try {
      defaultSelection = await this.harnessPolicyService?.resolveSmrSelection(tenantId);
    } catch {
      defaultSelection = undefined;
    }

    const providers = this.groupRegistryModelsByProvider(rows, defaultSelection);
    if (providers.length > 0) {
      return providers;
    }

    // Transition fallback: empty registry — fetch live providers from the SMR
    // service. The Python ProviderInfo model uses `status: str`
    // ("available"/"unavailable") rather than `is_available: boolean`, so we map
    // it here to satisfy the TypeScript SmrProvider interface.
    try {
      const base = this.getSmrBaseUrl();
      const response = await this.withRetry(
        () =>
          this.httpService.axiosRef.get(`${base}/api/v1/providers`, {
            headers: this.getForwardHeaders(),
            timeout: 5_000,
          }),
        'SMR providers fallback',
        1,
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (response.data as Array<Record<string, any>>).map((p) => ({
        ...p,
        is_available: p['status'] === 'available',
      }));
    } catch (err) {
      this.logger.warn({
        message: 'SMR service providers fallback failed — returning empty list',
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  // The guardrail listing reads ENABLED
  // GUARDRAIL registry rows and marks the effective `guardrail.validate`
  // default (AiTaskDefault tenant→SYSTEM cascade). There is no upstream-service
  // probe: an empty result simply means "not configured".
  //
  // This fail-CONFIGURED posture is deliberate:
  // discovery is deliberately NOT extended to the guardrail listing — a safety
  // plane must never appear configured because an engine happens to host a model.
  @Get('guardrail-providers')
  @Authorize()
  @ApiOperation({
    summary:
      'List Guardrail LLM providers/models from the AiModel registry (ENABLED GUARDRAIL rows), the effective guardrail.validate ' +
      `default marked. SUPER_ADMINs may explicitly target the GLOBAL tenant with ?tenantKey=${GLOBAL_TENANT_KEY}.`,
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getGuardrailProviders(@Query('tenantKey') tenantKey?: string): Promise<any[]> {
    const tenantId = await this.resolveTenantId(tenantKey);
    const rows = await this.fetchRegistryModels([ModelTaskType.GUARDRAIL]);

    // Effective default via the AiTaskDefault cascade; fail-open (no default
    // marked) when the resolver is unavailable or errors.
    let defaultSelection: { provider?: string | null; model?: string | null } | undefined;
    try {
      const effective = await this.aiTaskDefaultService?.getEffective('guardrail.validate', tenantId);
      defaultSelection = effective?.model ? { provider: effective.model.provider, model: effective.model.sourceUri } : undefined;
    } catch {
      defaultSelection = undefined;
    }

    return this.groupRegistryModelsByProvider(rows, defaultSelection);
  }
}
