import {
  AiModelService,
  Authorize,
  EffectiveSettingsService,
  HarnessPolicyService,
  IActiveUserContext,
  IAiRoutingPolicyService,
  IBlobStorageService,
  IComputeDeviceResolver,
  IConfigService,
  IDnaWritingStyleService,
  IEntitlementsService,
  IProviderConnectionService,
  ITenantService,
  IUsageLedgerService,
  LlmStreamUsageCollector,
  ModelResponse,
  parseStorageUri,
  readGenerationId,
  SecretsService,
  isSuperAdmin,
  TextRequestEnrichmentService,
  TENANTLESS,
  TENANT_ID_HEADER,
  buildGuardrailUsageBatches,
  buildLlmUsageBatches,
  parseTextUsageDetail,
  resolveDeployment,
  tenantHeaderValue,
  toLedgerProvider,
  DEFAULT_VISIT_TYPE_SERVICE,
  VisitTypeService,
  withUsageAttributes,
  type ComputeAugmentedBatch,
  type ComputeDevice,
  type UsageAttributes,
  type UsageEventBatchInput,
  type VisitTypeDefinition,
} from '@arcaai/applications';
import type { IBlobStorageService as IBlobStorageServiceType } from '@arcaai/applications';
import {
  AiDeploymentKind,
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
import type { Readable } from 'node:stream';

import { classifyDownstreamFailure, downstreamStatusFor } from '../../filters/downstream-error';
import { recordUsageEmissionFailure } from '../../observability/usage-emission-metric';
import type { Response } from 'express';
import { ClsService } from 'nestjs-cls';
import { StreamScope } from '../auth/decorators/stream-scope.decorator';
import { RequiredScopes, RequiredSvcScopes } from '../../decorators';

interface TextResponseFormat {
  type: 'text' | 'json' | 'json_schema';
  json_schema?: Record<string, unknown>;
  strict?: boolean;
}

interface TextGenerateRequest {
  prompt: string;
  system_prompt?: string;
  provider?: string;
  model?: string;
  temperature?: number;
  max_tokens?: number;
  top_p?: number;
  stream?: boolean;
  response_format?: TextResponseFormat;
  context?: Record<string, unknown>;
  /**
   * TASK-970 — the reasoning/thinking posture, ACCEPTED FROM THE CALLER.
   *
   * Unlike `provider_overrides` below, this one legitimately arrives from a
   * client: the LLM playground lets an admin drive reasoning per run. A caller
   * posture wins outright (`TextRequestEnrichmentService.callerPinnedReasoning`);
   * when absent the platform tier fills it in, which is what makes an unpinned
   * playground run obey `text.reasoning.defaultEffort` instead of silently
   * inheriting the engine's own default.
   */
  reasoning?: { enabled: boolean; effort?: 'minimal' | 'low' | 'medium' | 'high' };
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
       * (`'platform'`). TEXT reads it to stamp `usage_detail.byok`, which
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

/**
 * A visit type on the wire: a KEY or an ALIAS of the platform's two visit types
 * (`VisitTypeService`). It was a closed `'new_visit' | 'referral'` union — and both of
 * those are aliases of the "New visit" type, so a caller sending either is unaffected.
 */
type VisitType = string;
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
// connection, i.e. before any request bytes reached TEXT. Everything else
// (ECONNRESET/EPIPE/ETIMEDOUT, or ANY upstream response) may mean TEXT already
// started a billable generation, so the non-idempotent `/generate` POSTs must
// never retry on them (duplicate billing + divergent drafts).
const CONNECT_PHASE_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND']);

/**
 * TASK-969 WS-3 — the closed, non-PHI `error_code` vocabulary that may cross
 * the gateway boundary AS A CODE ONLY. The upstream `detail`/`message` is
 * NEVER forwarded (it can quote the prompt); this map supplies the gateway's
 * OWN fixed phrase per code, so the client can render the real cause without
 * TEXT's response body ever reaching it. A code absent from this map is
 * treated exactly like a missing one — the generic, redacted body below.
 */
const RELAYABLE_ERROR_PHRASES: Readonly<Record<string, string>> = {
  CONTENT_BLOCKED_NOT_MEDICAL: 'The prompt was not classified as clinical content and was blocked by the guardrail.',
  CONTENT_BLOCKED: 'Content was blocked by the safety guardrail.',
  GUARDRAIL_UNAVAILABLE: 'The safety guardrail is temporarily unavailable. Please retry shortly.',
  MODEL_NOT_SELECTED: 'No model is configured for this request.',
  PROVIDER_CREDENTIALS_MISSING: 'The AI provider is not configured with valid credentials.',
  VISION_NOT_SUPPORTED: 'The selected model does not support image input.',
  VALIDATION_ERROR: 'The request was invalid.',
  POOL_UNHEALTHY: 'The AI provider pool is temporarily unavailable.',
  // TASK-993 lane F — three codes TEXT has always been able to answer with and
  // that have never reached a client, because a code absent from this map is
  // replaced by the generic fallback and dropped.
  //
  // `RATE_LIMITED` is the one that cost something: lane B made TEXT retry a
  // vendor 429 and surface it as a real 429 + `Retry-After`, and the gateway
  // then answered "TEXT service unavailable" with no code and no header — the
  // caller could not tell a throttle from an outage, so it could not pace
  // itself. The other two are TASK-946's, in the same position.
  //
  // All three are CODES, not bodies: the phrase below is the gateway's own and
  // no part of the upstream `detail`/`message` crosses with them.
  RATE_LIMITED: 'The AI provider is rate limiting this request. Retry after the interval given in the Retry-After header.',
  PROVIDER_INVALID_REQUEST: 'The AI provider rejected the request as invalid.',
  CONTEXT_WINDOW_EXCEEDED: "The request exceeds the selected model's context window.",
};

/**
 * Upper bound on a relayed `Retry-After`, in seconds (TASK-993 lane F).
 *
 * A vendor that answers `Retry-After: 86400` would otherwise park a clinician's
 * console for a day. One hour is far past any real provider backoff and still
 * bounded, so a misbehaving upstream degrades into a long wait rather than an
 * indefinite one.
 */
const MAX_RELAYED_RETRY_AFTER_SECONDS = 3600;

const SSE_HEARTBEAT_INTERVAL_MS = 15_000;
// Read budget for an OPEN SSE hop (both the relayed subscription and the
// single-call `POST /generate` that now answers with the stream itself). A
// clinical generation runs for minutes; the 120 s body timeout would kill it.
const STREAM_READ_TIMEOUT_MS = 300_000;
// Cap extracted attachment text injected into a summarization prompt so a large
// document can't blow the TEXT context window. ~200k chars ≈ 50k tokens.
const ATTACHMENT_TEXT_LIMIT = 200_000;
const GLOBAL_TENANT_KEY = '__GLOBAL__';
// SUPER_ADMIN (formerly SUPER_ADMIN, renamed) is the single
// elevated role; the earlier, unrelated pre- SUPER_ADMIN role has
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
@Controller('text-generations')
// the streaming summarization surface parallel to the already-scoped
// `TextCompatController` (`/api/smr/api/v1`), which uses this same scope for
// the identical capability — kept in step deliberately.
@RequiredScopes('consultation:report:write')
// the standalone summarization/text-generation feature, reachable by
// the third credential class. Renamespaced from the `consultation:report:write`
// above, and deliberately the SAME scope the compat sibling declares: one
// capability, one grant, whichever door the caller uses.
@RequiredSvcScopes('svc:consultation:report:write')
export class TextProxyController {
  private readonly logger = new Logger(TextProxyController.name);

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
    // Resolves the tenant's effective TEXT {provider, model} when a
    // caller (playground/SDK) omits the model. @Optional so test fixtures that
    // construct the controller without it keep compiling.
    @Optional() @Inject(HarnessPolicyService) private readonly harnessPolicyService?: HarnessPolicyService,
    // The providers listings read the AiModel registry (the single
    // UI catalog) through the SHARED-READ query: visibility
    // is [caller tenant, SYSTEM] de-duplicated by slug, tenant clone wins.
    // @Optional so existing positional test fixtures keep compiling.
    @Optional() @Inject(AiModelService) private readonly aiModelService?: AiModelService,
    // Resolves the SYSTEM `guardrail.validate` routing election for the
    // guardrail listing's default marking (TASK-881: directly, the
    // `AiTaskDefault` facade is gone).
    @Optional() @Inject(IAiRoutingPolicyService) private readonly routingPolicies?: IAiRoutingPolicyService,
    // Resolves the caller tenant's BYO cloud credential for the
    // outgoing provider. @Optional so existing positional test fixtures (and
    // graphs that never proxy to TEXT) keep compiling.
    @Optional()
    @Inject(IProviderConnectionService)
    private readonly aiProviderConnectionService?: IProviderConnectionService,
    // Records the tokens a proxied stream consumed, on
    // teardown. @Optional so existing positional test fixtures keep compiling;
    // absent ⇒ the stream is simply not metered (it is never failed).
    @Optional()
    @Inject(IUsageLedgerService)
    private readonly usageLedger?: IUsageLedgerService,
    // the gated accessor for a doctor's effective DNA writing-style
    // text (tenant+doctor opt-out gate, latest report, decrypt). @Optional so
    // existing positional test fixtures keep compiling; absent ⇒ no style is
    // injected (matches the general fail-open-but-additive DNA posture).
    @Optional()
    @Inject(IDnaWritingStyleService)
    private readonly dnaWritingStyleService?: IDnaWritingStyleService,
    // A.2 — the tenant → SYSTEM cascade behind the `guardrail_policy`
    // push. @Optional so existing positional test fixtures keep compiling;
    // absent ⇒ no policy is pushed, which is identical to a tenant that has
    // expressed no opinion (the platform posture then stands).
    @Optional()
    private readonly effectiveSettingsService?: EffectiveSettingsService,
    // the caller tenant's VISIT-TYPE catalogue. This route
    // used to enforce a hardcoded `['new_visit', 'referral']` allow-list and
    // 400 anything else, which made "tenant-admin defined and controlled" false
    // at the front door. @Optional so existing positional test fixtures keep
    // compiling; absent ⇒ the two shipped visit types, whose aliases include
    // both of the values the old allow-list accepted.
    @Optional()
    @Inject(VisitTypeService)
    private readonly visitTypes?: VisitTypeService,
    // TASK-890 (§3.13) — this route RECORDED what a stream spent but never
    // checked whether the tenant could spend it, so a tenant at its
    // `monthlyLlmTokens` ceiling kept generating here while the same ceiling
    // stopped it on the summary path. @Optional + trailing so every existing
    // positional fixture keeps its arity; absent ⇒ ungated, as today.
    @Optional()
    @Inject(IEntitlementsService)
    private readonly entitlements?: IEntitlementsService,
    // TASK-959 §3.1 — which device a self-hosted LLM server runs on, the one thing `apps/text`
    // cannot report about itself (it is stateless per call and no request or model row carries a
    // device). The SHARED resolver, not a local read of the same descriptor: it already owns the
    // tenant → SYSTEM cascade, the membership check and the warn-once, and it never raises —
    // unresolvable degrades to `cpu` rather than to a lost usage batch. @Optional + trailing so
    // every existing positional fixture keeps its arity.
    @Optional()
    @Inject(IComputeDeviceResolver)
    private readonly computeDevice?: IComputeDeviceResolver,
  ) {
    // BUG-018 — the two enrichment steps now live in ONE applications-layer
    // service shared with the prompt-template test bench. Constructed here from
    // this controller's own (already injected) dependencies rather than taken as
    // another constructor parameter: the service is stateless, and every
    // existing positional test fixture keeps its arity and its exact behavior.
    this.textRequestEnrichment = new TextRequestEnrichmentService(this.clsService, this.aiProviderConnectionService, this.effectiveSettingsService);
  }

  private readonly textRequestEnrichment: TextRequestEnrichmentService;

  /**
   * SDK fidelity: a caller-supplied model is forwarded
   * untouched. When the model is absent, resolve SYSTEM `{provider, model}` via
   * HarnessPolicy. FAIL CLOSED: unresolved selection rethrows
   * (typically 400) — no silent omit → env fallback.
   *
   * ⚠ The `provider` branch below is NOT a tidy-up. This method used to resolve
   * ONLY when the model was absent, so a caller that pinned a model and omitted
   * the provider reached TEXT with `provider: undefined` — where
   * `_HARDCODED_DEFAULT_PROVIDER = "lm-studio"`
   * (`apps/text/src/text/models/requests.py`) silently took over and routed the
   * request to LM Studio whatever engine that model actually lives on. `model`
   * has no equivalent default (TEXT 422s without it), and that asymmetry was the
   * defect: one half of the selection failed loudly, the other guessed. The
   * gateway now always sends an explicit provider, which is also what has to be
   * true before that literal can be deleted from `apps/text`.
   *
   * The two branches are deliberately NOT collapsed into one "fill whatever is
   * missing" rule. `{provider, model}` is a PAIR: the resolved model belongs to
   * the resolved provider. Honouring a caller-supplied provider while filling
   * the model from a resolution that may have chosen a different provider would
   * forward an incoherent pair — a new failure mode, not a fix. So:
   *
   *   - model absent → resolve BOTH (byte-identical to before);
   *   - model pinned, no provider → fill the PROVIDER only, model untouched;
   *   - provider pinned + model pinned → nothing is resolved or overwritten.
   */
  private async applyTextModelSelection<T extends { provider?: string; model?: string }>(target: T): Promise<T> {
    if (!target.model && this.harnessPolicyService) {
      const tenantId = this.clsService.get('tenantId');
      const { provider, model } = await this.harnessPolicyService.resolveTextSelection(tenantId);
      target.provider = provider;
      target.model = model;
    } else if (!target.provider && this.harnessPolicyService) {
      // Selection is `failMode: closed`, so an unresolvable tenant surfaces an
      // error here rather than inheriting TEXT's literal further downstream.
      const tenantId = this.clsService.get('tenantId');
      const { provider } = await this.harnessPolicyService.resolveTextSelection(tenantId);
      target.provider = provider;
    }
    // (TASK-862: the runtime-profile layer that used to run here is gone with
    // `AiRuntimeProfile`; generation parameters arrive with the Agent, TASK-863.)
    // Push the caller tenant's own moderation policy, if it has one. Runs
    // BEFORE the credential fold because that step can legitimately RAISE (a
    // provider veto → 409, a missing entitlement → 403), and a policy refusal
    // should not be reached with a half-built body.
    await this.textRequestEnrichment.applyTenantGuardrailPolicy(target);
    // TASK-970 — the reasoning posture. This proxy is the ONE text path that
    // never applied it: every other caller of `applyTextRuntimeProfile` is an
    // applications-layer service resolving an Agent, so a playground / SDK call
    // arriving here carried no posture at all and the engine decided for itself.
    // That is why reasoning stayed on in the playground no matter what any agent
    // or platform setting said.
    //
    // No `generation` argument is passed on purpose: there is no Agent behind a
    // caller-pinned provider/model, so the cascade is exactly "caller posture, else
    // platform tier" — and a caller that sent `reasoning` short-circuits it.
    await this.textRequestEnrichment.applyTextRuntimeProfile(target);
    // Then fold in the caller tenant's BYO cloud credential, if any.
    return this.applyTenantProviderOverrides(target);
  }

  /**
   * Fold the caller tenant's BYO cloud credential into the forwarded body as
   * `provider_overrides`.
   *
   * BUG-018 — the implementation MOVED VERBATIM to the applications-layer
   * `TextRequestEnrichmentService` so the prompt-template test bench (which used
   * to POST to TEXT directly, on platform credentials) shares exactly one
   * implementation with this proxy. Semantics are unchanged: cloud-only,
   * minimal exposure, fail-open on a resolver error, and the policy-refusal
   * `assertProviderAvailable` check outside that catch.
   */
  private async applyTenantProviderOverrides<T extends { provider?: string }>(target: T): Promise<T> {
    return this.textRequestEnrichment.applyTenantProviderOverrides(target);
  }

  // The TEXT base URL resolves through the
  // typed `IConfigService.getConfigValue('TEXT_URL')` accessor. A direct
  // `process.env.TEXT_URL || 'http://localhost:8862'`
  // read is forbidden by the `no-direct-downstream-url-env` lint
  // rule; the env-or-fallback resolution happens once at bootstrap
  // in `ConfigService.loadBaseConfig()`.
  private getTextBaseUrl(): string {
    return this.configService.getConfigValue('TEXT_URL');
  }

  /**
   * Headers for every gateway→TEXT hop out of this controller.
   *
   * `X-Tenant-Id` is MANDATORY here. It was omitted UNCONDITIONALLY on
   * all seven call sites below, so TEXT resolved `x_tenant_id=None` and fell back to
   * the platform default — never applying the tenant's own BYOK provider/credential,
   * and (because it derives `funding`/`cost_basis` from whichever tier supplied
   * the credential) mis-attributing the spend, with nothing thrown or logged anywhere.
   *
   * A SUPER_ADMIN driving these routes with no working tenant selected genuinely has
   * no tenant; that case DECLARES itself with the `tenantless:platform-operator`
   * marker rather than sending nothing, so an absent header stays unambiguously a bug.
   *
   * D-D: the token is the ONE shared `INTERNAL_ACCESS_TOKEN`. The per-service
   * `TEXT_SERVICE_TOKEN` fallback was retired once the shared token was
   * deployed everywhere. The lookup is the SYNC cache read warmed at bootstrap,
   * preserving the existing fail-open-on-miss behaviour.
   */
  private getForwardHeaders(): Record<string, string> {
    const serviceToken = this.secretsService?.getSecretSync('INTERNAL_ACCESS_TOKEN') || '';
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      [TENANT_ID_HEADER]: tenantHeaderValue(this.clsService?.get('tenantId'), TENANTLESS.PLATFORM_OPERATOR),
    };
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
   * failure means TEXT may already be generating — retrying would re-invoke it.
   */
  private isConnectPhaseFailure(err: unknown): boolean {
    const axiosError = err as AxiosError;
    if (axiosError?.response) return false; // upstream responded → request was delivered
    const code = axiosError?.code;
    return typeof code === 'string' && CONNECT_PHASE_CODES.has(code);
  }

  /**
   * Relay the upstream's `Retry-After` onto this response (TASK-993 lane F).
   *
   * `HttpException` carries no headers, and `HttpExceptionEnvelopeFilter`
   * writes the body with `.status().json()` — which does NOT clear headers
   * already set — so setting it here survives the throw that follows.
   *
   * The VALUE is re-rendered, never forwarded: the upstream string is parsed
   * to an integer, floored at 1 and capped, and the gateway emits its own
   * rendering. That is the same posture the body takes (a code may cross, a
   * string may not), and it means an upstream cannot inject a header value or
   * hand a client an unbounded sleep. An HTTP-date form is deliberately NOT
   * honoured: every consumer in this platform reads `retry-after` as a number
   * (`@arcaai/vox-node` `core/errors.ts`), and a date it silently parses as
   * `NaN` is worse than no header at all.
   */
  private relayRetryAfter(err: unknown, res: Response | undefined): void {
    if (!res || typeof res.setHeader !== 'function' || res.headersSent) return;

    const raw = (err as AxiosError)?.response?.headers?.['retry-after'];
    const seconds = Number(Array.isArray(raw) ? raw[0] : raw);
    if (!Number.isFinite(seconds)) return;

    const bounded = Math.min(MAX_RELAYED_RETRY_AFTER_SECONDS, Math.max(1, Math.ceil(seconds)));
    try {
      res.setHeader('Retry-After', String(bounded));
    } catch {
      // A response already committed (a stream) cannot take a late header.
      // Losing the hint must never cost the error itself.
    }
  }

  /**
   * @param res - present only on the handlers that can carry a vendor 429, so
   *   the upstream `Retry-After` can be relayed (TASK-993 lane F). Omitted
   *   elsewhere, where there is nothing to relay.
   */
  private buildUpstreamException(err: unknown, fallbackMessage: string, res?: Response): HttpException {
    const axiosError = err as AxiosError<UpstreamErrorPayload | string>;
    const status = axiosError.response?.status;
    const payload = axiosError.response?.data;

    if (status === HttpStatus.TOO_MANY_REQUESTS) {
      this.relayRetryAfter(err, res);
    }

    // The raw upstream error body can echo the assembled
    // clinical prompt / PHI or internal TEXT/LM-Studio stack detail. It MUST NOT
    // reach the client AND MUST NOT be written to logs (stdout → k8s/Loki, outside
    // PHI controls). Record only NON-CONTENT metadata — the upstream status, the
    // request correlation id, and an explicit redaction sentinel — so operators can
    // correlate the failure without the body ever landing in telemetry. Return a
    // GENERIC message; the status-code mapping is preserved (the semantic lives in
    // the status, not the body). This replaces both former verbatim-forward
    // branches AND the earlier interim fix that logged the raw body.
    if (payload !== undefined && payload !== null && payload !== '') {
      this.logger.error({
        message: 'TEXT upstream error (body redacted — may contain PHI/prompt content)',
        upstreamStatus: status,
        correlationId: this.clsService.getId(),
        upstreamBodyRedacted: true,
      });
    }

    // TASK-969 WS-3: an `error_code` on the closed allow-list may cross AS A
    // CODE — never the upstream `detail`/`message` alongside it, which is why
    // this reads ONLY `error_code` off `payload` and looks up the gateway's own
    // phrase rather than ever touching `payload.detail`/`payload.message`.
    const errorCode = typeof payload === 'object' && payload !== null ? payload.error_code : undefined;
    const relayedMessage = typeof errorCode === 'string' ? RELAYABLE_ERROR_PHRASES[errorCode] : undefined;

    if (typeof status === 'number') {
      if (relayedMessage !== undefined) {
        return new HttpException({ detail: relayedMessage, error_code: errorCode }, status);
      }
      return new HttpException({ detail: fallbackMessage }, status);
    }

    // no upstream status means the peer never answered — a TRANSPORT
    // failure, which is 503 (retryable), not 502 (the peer answered badly). The
    // status now comes from the shared classifier so this controller and the
    // gateway boundary can never disagree; the v1 body SHAPE is unchanged.
    const kind = classifyDownstreamFailure(err);
    return new HttpException({ detail: fallbackMessage }, kind ? downstreamStatusFor(kind) : HttpStatus.BAD_GATEWAY);
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
   * default provider/model (HarnessPolicy for TEXT, AiRoutingPolicy for guardrail).
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
  @ApiOperation({ summary: 'Generate text via TEXT (sync or streaming)' })
  // `@Res({ passthrough: true })` — Nest still serialises the return value and
  // still routes a thrown exception through the filters; the response object
  // is taken only so a vendor `Retry-After` can be relayed (TASK-993 lane F).
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async generate(@Body() body: TextGenerateRequest, @Res({ passthrough: true }) res?: Response): Promise<any> {
    // OUTSIDE the try below, deliberately: that catch turns everything it sees
    // into `buildUpstreamException` ("TEXT service unavailable"), which would
    // disguise a 429 quota refusal as a 502 the caller cannot act on.
    await this.assertLlmAllowance();
    const base = this.getTextBaseUrl();
    await this.applyTextModelSelection(body);

    try {
      return await this.postTextGenerate(base, body, 'TEXT generate');
    } catch (err) {
      const upstreamStatus = (err as AxiosError)?.response?.status;
      this.logger.error({
        message: 'Failed to proxy generate request to TEXT',
        error: err instanceof Error ? err.message : String(err),
        code: (err as AxiosError)?.code,
        upstreamStatus,
      });
      throw this.buildUpstreamException(err, 'TEXT service unavailable', res);
    }
  }

  /**
   * `POST /api/v1/generate` under the single-call contract,
   * returning what this gateway's TWO-CALL surface promises its callers.
   *
   * Non-streaming is unchanged: the JSON body, passed through.
   *
   * Streaming is the migration. TEXT no longer answers `202 {task_id,
   * stream_url}`; it answers **200 + `text/event-stream` immediately**, with the
   * generation id in the first frame's `data`. Buffering that (which
   * is what axios does by default, and what this method used to get) would
   * accumulate an entire clinical generation into a string, hand it back as if
   * it were a JSON ack, and time out at 30 s. So we stream it, take the id off
   * the first frame, and drop this subscription.
   *
   * Dropping it is NOT a cancel: the producer is owned by TEXT's
   * generation hub, not by this response, so it runs on and every delta lands in
   * the replay buffer. The caller's own `GET .../stream` then replays from seq 0
   * — no gap, and this gateway holds no state.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private async postTextGenerate(base: string, payload: TextGenerateRequest, label: string): Promise<any> {
    const streaming = payload.stream === true;
    const response = await this.withRetry(
      () =>
        this.httpService.axiosRef.post(`${base}/api/v1/generate`, payload, {
          headers: streaming ? { ...this.getForwardHeaders(), Accept: 'text/event-stream' } : this.getForwardHeaders(),
          ...(streaming ? { responseType: 'stream' as const, timeout: STREAM_READ_TIMEOUT_MS } : { timeout: 120_000 }),
        }),
      label,
      // /generate is non-idempotent (billable generation):
      // retry ONLY when the request provably never reached TEXT.
      2,
      (err) => this.isConnectPhaseFailure(err),
    );

    // TASK-957 F-7a — the sync half of this route emitted NOTHING. Its STREAMING twin has
    // metered since TASK-890, so the same playground, on the same platform credential, billed
    // one of its two response modes and not the other. Emitted from HERE rather than from
    // `generate()` because this is the ONE place a non-streaming TEXT generation lands — the
    // assembled-prompt sibling routes through it too, and a second copy in each caller is a
    // second chance to double-bill the same task id.
    if (!streaming) {
      this.emitSyncGenerationUsage(response.data);
      return response.data;
    }

    const taskId = await readGenerationId(response.data as Readable);
    return {
      task_id: taskId,
      status: 'streaming',
      // Gateway-relative, not the service-relative path TEXT used to report:
      // the caller talks to the gateway, with a `text_task:<taskId>` ticket.
      stream_url: `text-generations/tasks/${encodeURIComponent(taskId)}/stream`,
      created_at: new Date().toISOString(),
    };
  }

  /**
   * Bill a NON-streaming TEXT generation (TASK-957 F-7a).
   *
   * The same shape as this controller's SSE teardown and as the agent plane's blocking
   * invocation, and deliberately so — one route answering in two response modes must not bill
   * two different ways:
   *
   *  · The key is TEXT's OWN `task_id` (`llm:<task_id>`), not a fresh gateway id. It is the only
   *    join between a ledger row and TEXT's persisted task log, which is what a disputed invoice
   *    is reconciled from, and it is what makes a redelivery converge instead of double-billing.
   *  · `usage_detail` carries the cache-read/write and reasoning split, the endpoint kind and
   *    service tier the rater picks price rows by, the connection id, TEXT's own clock, and the
   *    compute/byte readings. The flat `usage` block carries two counts and would under-bill
   *    every cloud model that reports a cache or a reasoning split.
   *  · `guardrail_usage` is the screening call TEXT made on this request's behalf — COGS the
   *    `GUARDRAIL_CALLS` meter never saw from this route (D16: metered, never invoiced).
   *
   * Fire-and-forget with a swallowed rejection, exactly like the stream path: the generation
   * already happened and the caller already has its bytes, so a metering failure degrades to
   * "not metered", never to a failed request.
   */
  private emitSyncGenerationUsage(data: unknown): void {
    const tenantId = this.clsService.get('tenantId');
    if (!this.usageLedger || !tenantId) return;
    const ledger = this.usageLedger;

    const body = (data ?? {}) as Record<string, unknown>;
    const generation = parseTextUsageDetail(body.usage_detail);
    const screening = parseTextUsageDetail(body.guardrail_usage);
    // Nothing TEXT reported is billable — an older service, or a response that carried no usage
    // block at all. Fabricating an `endpointKind` to reach the richer builder would stamp an API
    // shape that never happened, so this records nothing rather than guessing.
    if (!generation && !screening) return;

    const emit = async (): Promise<void> => {
      // How this call was SCREENED, for the generation row. The proxy pushes no opt-out
      // (`applyTextModelSelection` leaves `enabled` absent and the PLATFORM posture governs), so
      // the answer here can only ever be `screened` or `platform_off` — never `opted_out`.
      const guardrail = await this.textRequestEnrichment.guardrailDisposition({ enabled: true });

      const inputs: UsageEventBatchInput[] = [];
      if (generation) {
        inputs.push(
          ...usageBatches(
            buildLlmUsageBatches({
              usage: generation,
              tenantId,
              operation: 'generate',
              device: await this.llmDeviceFor(tenantId, generation),
            }),
            { guardrail },
          ),
        );
      }
      if (screening) {
        // The screening call is its OWN provider call — its own operation, its own key, and its
        // own device (a tenant may screen on one engine and generate on another). It carries NO
        // `guardrail` disposition: stamping how a generation was screened onto the screening
        // itself is circular.
        inputs.push(
          ...usageBatches(
            buildGuardrailUsageBatches({
              usage: screening,
              tenantId,
              fallbackRequestId: generation?.taskId ?? null,
              device: await this.llmDeviceFor(tenantId, screening),
            }),
            {},
          ),
        );
      }

      for (const input of inputs) {
        await ledger.recordUsage(input);
      }
    };

    void emit().catch((error: unknown) => {
      // TASK-957 F-5 — a `warn` alone is indistinguishable from noise at request volume, and an
      // unbilled generation that only ever appears in a log is exactly the finding. The counter
      // is the alertable half.
      recordUsageEmissionFailure('generate', 'dropped');
      this.logger.warn({
        message: 'Usage metering failed for a sync TEXT generation',
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  /** The device a parsed usage block's OWN provider ran on — see {@link llmDevice}. */
  private async llmDeviceFor(tenantId: string, usage: { textProvider: string; byok: boolean }): Promise<ComputeDevice | null> {
    const provider = toLedgerProvider(usage.textProvider);
    return this.llmDevice(tenantId, provider, resolveDeployment(provider, usage.byok));
  }

  @Get('tasks/:taskId')
  @Authorize()
  @ApiOperation({ summary: 'Get task status from TEXT' })
  @ApiParam({ name: 'taskId', description: 'Task ID' })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getTaskStatus(@Param('taskId') taskId: string): Promise<any> {
    const base = this.getTextBaseUrl();

    try {
      const response = await this.withRetry(
        () =>
          this.httpService.axiosRef.get(`${base}/api/v1/tasks/${taskId}`, {
            headers: this.getForwardHeaders(),
          }),
        `TEXT task status ${taskId}`,
      );

      return response.data;
    } catch (err) {
      const upstreamStatus = (err as AxiosError)?.response?.status;
      this.logger.error({
        message: 'Failed to get task status from TEXT',
        taskId,
        error: err instanceof Error ? err.message : String(err),
        upstreamStatus,
      });
      throw this.buildUpstreamException(err, 'TEXT service unavailable');
    }
  }

  @Post('tasks/:taskId/cancel')
  @Authorize()
  @ApiOperation({ summary: 'Cancel a running TEXT task' })
  @ApiParam({ name: 'taskId', description: 'Task ID to cancel' })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async cancelTask(@Param('taskId') taskId: string): Promise<any> {
    const base = this.getTextBaseUrl();

    try {
      const response = await this.httpService.axiosRef.post(`${base}/api/v1/tasks/${taskId}/cancel`, {}, { headers: this.getForwardHeaders() });

      return response.data;
    } catch (err) {
      const upstreamStatus = (err as AxiosError)?.response?.status;
      this.logger.error({
        message: 'Failed to cancel TEXT task',
        taskId,
        error: err instanceof Error ? err.message : String(err),
        upstreamStatus,
      });
      throw this.buildUpstreamException(err, 'TEXT service unavailable');
    }
  }

  /**
   * The gateway KEEPS its two-call surface, deliberately.
   *
   * TEXT moved to a single call — `POST /generate` IS the stream — and this
   * gateway now speaks that contract upstream (`postTextGenerate`). It does not
   * expose it downstream, for three reasons that are properties of the browser
   * hop rather than preferences:
   *
   *  1. **The stream ticket is scoped to a path param.** `@StreamScope({
   *     namespace: 'text_task', param: 'taskId' })` mints and checks
   *     `text_task:<taskId>`. A POST-that-is-the-stream has no id until its
   *     first frame, so there is nothing to scope a ticket to.
   *  2. **`EventSource` cannot POST** and cannot set `Authorization` — which is
   * precisely why the ticket-in-query design exists (it makes the same
   *     observation about browsers).
   *  3. The console and `PromptManagementService` both hand a browser a GET URL
   *     to open; neither owns a `fetch`-based SSE reader.
   *
   * Upstream retains `GET /tasks/{id}/stream` as an alias of the resume
   * endpoint, so this costs nothing: the gateway stays a stateless relay over a
   * generation TEXT already owns, and the id round-trip through `postTextGenerate`
   * loses nothing because the producer outlives every subscriber.
   */
  @Get('tasks/:taskId/stream')
  @Authorize()
  @StreamScope({ namespace: 'text_task', param: 'taskId' })
  @ApiOperation({
    summary: 'Stream task chunks via SSE from TEXT',
    description:
      'Server-Sent Events stream. Accepts either `Authorization: Bearer <jwt>` or a single-use `?ticket=<ticket>` issued by `POST /auth/stream-ticket` with scope `text_task:<taskId>`. Send `Last-Event-ID` to resume an interrupted stream from its cursor; the gateway forwards it upstream and relays `id:` back unchanged.',
  })
  @ApiParam({ name: 'taskId', description: 'Task ID to stream' })
  async streamTaskEvents(
    @Param('taskId') taskId: string,
    @Headers('last-event-id') lastEventId: string | undefined,
    @Res() res: Response,
  ): Promise<void> {
    const base = this.getTextBaseUrl();

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

    // Meter what flows through the pipe.
    //
    // The proxy stays a byte pipe: every chunk is forwarded VERBATIM and the
    // usage block is read from a side copy, which holds only the bytes after
    // the last complete frame boundary — so memory does not grow with the
    // length of a long generation.
    const tenantId = this.clsService.get('tenantId');

    // TASK-890 — the frame scanning, the emit-once guard and the bounded
    // carry-over moved VERBATIM into `LlmStreamUsageCollector`
    // (`usageLedger/llm-stream-usage.ts`), because three more paths — agent
    // invocation, the prompt test bench, the draft-agent test — now tee the
    // same way and a second copy of this is a second place for a dropped tail
    // to become lost revenue.
    const collector = new LlmStreamUsageCollector();

    // Teardown fires from three places (`end`, `error`, client `close`) and can
    // fire more than once. Emission is idempotent at the ledger anyway — the
    // key is derived from the task id — but emitting once keeps the outbox from
    // absorbing three copies of every stream.
    // TASK-890 §3.14 (OD-R) — how this call was screened, for the ledger row.
    //
    // The proxy pushes NO opt-out: `postTextGenerate` applies the tenant's `require_medical` /
    // `include_reasoning` policy and leaves `enabled` absent, so the PLATFORM posture governs
    // the generation. Its rows can therefore only ever say `screened` or `platform_off` — never
    // `opted_out`, because no agent / workflow / node opinion reaches this route. Resolved once,
    // before any frame arrives, so all three teardown paths stamp the same answer.
    const guardrail = await this.textRequestEnrichment.guardrailDisposition({ enabled: true });

    // TASK-959 — PEEK, RESOLVE, THEN TAKE. The device decides the compute UNIT and is resolved
    // from configuration keyed by the provider that ACTUALLY served, which is only known once the
    // terminal frame is parsed — and that resolution is asynchronous, while the batch is built
    // synchronously inside `takeAll`. So the attribution is read first, without consuming
    // anything. `takeAll()` still answers ONCE, so the three teardown handlers (`end`, `error`,
    // the client's `close`) produce exactly one emission however many of them fire, including
    // across the `await` below where two may legitimately be in flight at the same time.
    //
    // `takeAll` also hands back what `take` dropped: the `guardrail.validate` COGS row for the
    // guard call TEXT made on this stream's behalf, and the platform CPU leg of a BYOK stream.
    const emitUsageOnce = (): void => {
      if (!this.usageLedger || !tenantId) return;
      const ledger = this.usageLedger;

      const emit = async (): Promise<void> => {
        const attribution = collector.peekGenerationAttribution();
        const device = attribution ? await this.llmDevice(tenantId, attribution.provider, attribution.deployment) : null;
        const batches = collector.takeAll({ tenantId, operation: 'generate.stream', device });
        if (!batches) return;

        // `guardrail` is the disposition of the GENERATION — how this call was screened. The
        // screening call is not itself screened, so stamping it there would be circular.
        for (const input of [...usageBatches(batches.generation, { guardrail }), ...usageBatches(batches.guardrail, {})]) {
          await ledger.recordUsage(input);
        }
      };

      // Fire-and-forget with a swallowed rejection: the generation already
      // happened and the client already has its bytes. A metering failure must
      // degrade to "not metered", never to a broken stream.
      void emit().catch((error: unknown) => {
        this.logger.warn({
          message: 'Usage metering failed for a proxied TEXT stream',
          taskId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
    };

    try {
      // forward the cursor upstream. `Last-Event-ID` is the
      // CANONICAL form and is what TEXT's `parse_cursor` reads first; the
      // `?last_event_id=` query is kept alongside it because TEXT accepts both
      // and a stripped header would resume the generation from seq 0 SILENTLY,
      // which is indistinguishable from working until a clinician notices the
      // duplicated prefix. (The upstream docstring says `?from=`; the parameter
      // FastAPI actually binds is `from_seq` — neither is what we send.)
      const streamUrl = lastEventId
        ? `${base}/api/v1/tasks/${taskId}/stream?last_event_id=${encodeURIComponent(lastEventId)}`
        : `${base}/api/v1/tasks/${taskId}/stream`;
      const upstream = await this.httpService.axiosRef.get(streamUrl, {
        headers: {
          ...this.getForwardHeaders(),
          Accept: 'text/event-stream',
          ...(lastEventId ? { 'Last-Event-ID': lastEventId } : {}),
        },
        responseType: 'stream',
        timeout: STREAM_READ_TIMEOUT_MS,
      });

      const stream = upstream.data;

      heartbeatTimer = setInterval(() => {
        if (!res.writableEnded) {
          res.write(':keepalive\n\n');
        }
      }, SSE_HEARTBEAT_INTERVAL_MS);

      stream.on('data', (chunk: Buffer) => {
        res.write(chunk);
        collector.observe(chunk);
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
          message: 'SSE stream error from TEXT',
          taskId,
          error: err.message,
        });
        res.end();
      });

      res.on('close', () => {
        if (heartbeatTimer) clearInterval(heartbeatTimer);
        // The client hung up. Whatever usage already crossed the wire is real
        // and must be recorded.
        emitUsageOnce();
        // drop ONLY our own upstream subscription. This is
        // deliberately NOT a cancel: TEXT's producer outlives every subscriber
        // and cancellation is an explicit `POST .../cancel`,
        // so the generation runs on and the client resumes it gaplessly from its
        // `Last-Event-ID`. Calling the cancel route from here would destroy the
        // resumability this relay exists to carry.
        stream.destroy();
      });
    } catch (err) {
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      const axiosError = err as AxiosError<UpstreamErrorPayload | string>;
      const upstreamStatus = axiosError.response?.status;
      this.logger.error({
        message: 'Failed to connect to TEXT SSE stream',
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
        res.status(status).json({ detail: 'TEXT service unavailable' });
      } else {
        res.end();
      }
    }
  }

  @Post('generate/assembled')
  @Authorize()
  @ApiOperation({ summary: 'Generate text with server-side prompt assembly (debug mode)' })
  // `@Res({ passthrough: true })` for the same reason as `generate()` above.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async generateAssembled(@Body() body: AssembledGenerateRequest, @Res({ passthrough: true }) res?: Response): Promise<any> {
    this.validateAssembledRequest(body);
    this.requireDebugAccess(body.debug);
    // Before the assembly work, and outside the try below (same reason as
    // `generate()`): a refused allowance must reach the caller as its own 429.
    await this.assertLlmAllowance();

    const { prompt, systemPrompt, resolvedMeta } = await this.assemblePrompt(body);

    const textPayload: TextGenerateRequest = {
      prompt,
      system_prompt: systemPrompt,
      provider: body.provider,
      model: body.model,
      temperature: body.temperature,
      max_tokens: body.max_tokens,
      stream: body.stream ?? false,
    };
    await this.applyTextModelSelection(textPayload);

    const base = this.getTextBaseUrl();

    try {
      // Same single-call contract and same single-delivery retry as `generate()`.
      const data = await this.postTextGenerate(base, textPayload, 'TEXT assembled generate');

      return {
        ...data,
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
        message: 'Failed to proxy assembled generate request to TEXT',
        error: err instanceof Error ? err.message : String(err),
        code: (err as AxiosError)?.code,
        upstreamStatus,
      });
      throw this.buildUpstreamException(err, 'TEXT service unavailable', res);
    }
  }

  /**
   * TASK-890 (§3.13) — the caller tenant's LLM-token allowance.
   *
   * This route RECORDED what a stream spent but never checked whether the
   * tenant could spend it, so a tenant at its `monthlyLlmTokens` ceiling kept
   * generating here while the same ceiling stopped it on the summary path.
   *
   * Post-hoc debit (D6): a request's own token count is unknowable until TEXT
   * answers, so this compares month-to-date rollups against the allowance
   * rather than predicting the call — the same call shape `summary.service.ts`
   * uses. Kill-switch-gated inside; → 429 once over.
   */
  private async assertLlmAllowance(): Promise<void> {
    await this.entitlements?.assertMeterQuota(this.clsService.get('tenantId'), 'monthlyLlmTokens');
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
    if (body.visit_type && !this.resolveVisitType(body.visit_type)) {
      const known = this.visitTypeCatalogue()
        .flatMap((entry) => [entry.key, ...entry.aliases])
        .join('", "');
      throw new BadRequestException(`visit_type must be one of "${known}" — the visit types configured for this tenant`);
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
        // TEXT (which is text-in/text-out) can summarize the document.
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
      // The TEXT proxy assembles prompts on behalf of the caller; without
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
      // through the same gated accessor `text-compat` uses
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
      // The tenant's own LABEL for the visit type, not a two-branch literal.
      // `validateAssembledRequest` has already refused anything the catalogue
      // does not name, so the raw value is only a defensive last resort.
      const visitLabel = this.resolveVisitType(body.visit_type)?.label ?? body.visit_type;
      // Stated as a LABELLED FIELD, not as a sentence the label has to fit
      // grammatically. It used to read `This is a ${visitLabel} visit.`, which
      // only worked while the labels were platform literals chosen to fit it:
      // the owner's 2026-08-29 label "New visit" renders that as "This is a New
      // visit visit.", and a tenant is free to define a label worse still. This
      // form is the one every seeded prompt body already uses for the same fact
      // (`- **Visit Type:** {visit_type}`), and no label can break it.
      systemPrompt += `\n\nVisit type: ${visitLabel}.`;
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
  // retired `text-provider-models`/`default-text-*` GlobalSetting keys. The
  // tenant's effective default still comes from the HarnessPolicy cascade
  // (`applyTextModelSelection` untouched). The live TEXT probe survives ONLY as
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
      'List LLM providers/models from the AiModel registry (ENABLED TEXT_GENERATION/SUMMARIZATION rows), with a live TEXT probe ' +
      `fallback when the registry is empty. SUPER_ADMINs may explicitly target the GLOBAL tenant with ?tenantKey=${GLOBAL_TENANT_KEY}.`,
  })
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async getProviders(@Query('tenantKey') tenantKey?: string): Promise<any[]> {
    const tenantId = await this.resolveTenantId(tenantKey);
    const rows = await this.fetchRegistryModels([ModelTaskType.TEXT_GENERATION, ModelTaskType.SUMMARIZATION]);

    // Default marking from the tenant's effective TEXT selection; fail-open (no
    // default marked) when the cascade is unresolved.
    let defaultSelection: { provider: string; model: string } | undefined;
    try {
      defaultSelection = await this.harnessPolicyService?.resolveTextSelection(tenantId);
    } catch {
      defaultSelection = undefined;
    }

    const providers = this.groupRegistryModelsByProvider(rows, defaultSelection);
    if (providers.length > 0) {
      return providers;
    }

    // Transition fallback: empty registry — fetch live providers from the TEXT
    // service. The Python ProviderInfo model uses `status: str`
    // ("available"/"unavailable") rather than `is_available: boolean`, so we map
    // it here to satisfy the TypeScript TextProvider interface.
    try {
      const base = this.getTextBaseUrl();
      const response = await this.withRetry(
        () =>
          this.httpService.axiosRef.get(`${base}/api/v1/providers`, {
            headers: this.getForwardHeaders(),
            timeout: 5_000,
          }),
        'TEXT providers fallback',
        1,
      );
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      return (response.data as Array<Record<string, any>>).map((p) => ({
        ...p,
        is_available: p['status'] === 'available',
      }));
    } catch (err) {
      this.logger.warn({
        message: 'TEXT service providers fallback failed — returning empty list',
        error: err instanceof Error ? err.message : String(err),
      });
      return [];
    }
  }

  // The guardrail listing reads ENABLED
  // GUARDRAIL registry rows and marks the effective `guardrail.validate`
  // default (AiRoutingPolicy tenant→SYSTEM cascade). There is no upstream-service
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

    // The SYSTEM `guardrail.validate` election (guardrail is platform-only, so
    // `systemOnly`); fail-open (no default marked) when the resolver is
    // unavailable or errors — this only decorates a listing.
    let defaultSelection: { provider?: string | null; model?: string | null } | undefined;
    try {
      const resolved = await this.routingPolicies?.resolveDefault(tenantId, 'guardrail.validate', { systemOnly: true });
      defaultSelection = resolved?.model ? { provider: resolved.model.provider ?? null, model: resolved.model.sourceUri } : undefined;
    } catch {
      defaultSelection = undefined;
    }

    return this.groupRegistryModelsByProvider(rows, defaultSelection);
  }

  /**
   * Which device a stream's seconds were spent on — `null` when this gateway has no business
   * naming one (TASK-959 §3.1).
   *
   * A CLOUD or BYOK stream is NOT the vendor's hardware: those seconds are the platform's own CPU
   * spent CALLING the vendor, which the appender meters as `cpu` whatever is passed, so nothing
   * is resolved for them and the cascade is not read at all. Only a self-hosted server has a
   * device worth looking up, and `apps/text` cannot report it — it is stateless per call and
   * neither `GenerateRequest` nor `AiModel` carries one (`computeType` is a precision, not a
   * device).
   *
   * `null` also when the resolver is not wired (a positional fixture) or when it raises despite
   * its contract not to: no compute row, never a guessed one, and never a lost usage batch.
   */
  private async llmDevice(tenantId: string, provider: string, deployment: AiDeploymentKind): Promise<ComputeDevice | null> {
    if (deployment !== AiDeploymentKind.SELF_HOSTED) return null;
    try {
      return (await this.computeDevice?.resolve(tenantId, provider)) ?? null;
    } catch (error: unknown) {
      this.logger.warn({
        message: 'Compute device unresolved; metering this stream without a compute row',
        provider,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  /** The caller tenant's visit-type catalogue (tenant → SYSTEM), or the shipped default. */
  private visitTypeCatalogue(): readonly VisitTypeDefinition[] {
    return (this.visitTypes ?? DEFAULT_VISIT_TYPE_SERVICE).catalogue(this.clsService?.get('tenantId') ?? null);
  }

  /** The catalogue entry a wire `visit_type` names, by key or alias, or `null`. */
  private resolveVisitType(raw: string): VisitTypeDefinition | null {
    return (this.visitTypes ?? DEFAULT_VISIT_TYPE_SERVICE).match(this.clsService?.get('tenantId') ?? null, raw);
  }
}

/**
 * Both halves of an augmented pair (TASK-959 §6.3), each carrying the same stamped dimensions —
 * the platform CPU leg of a BYOK stream is the same product activity, screened the same way, as
 * the tokens beside it. A non-BYOK pair flattens to the one batch it always was.
 */
function usageBatches(pair: ComputeAugmentedBatch | null, attributes: UsageAttributes): UsageEventBatchInput[] {
  if (!pair) return [];
  const halves = pair.platformBatch ? [pair.batch, pair.platformBatch] : [pair.batch];
  return halves.map((batch) => withUsageAttributes(batch, attributes) ?? batch);
}
