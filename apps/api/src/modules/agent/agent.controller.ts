import {
  AgentInvocationService,
  AgentResolverService,
  AsrAgentResolverService,
  AgentSummaryListResponse,
  AgentSummaryResponse,
  AgentTask,
  Authorize,
  COMPUTE_DEVICES,
  IActiveUserContext,
  IAgentService,
  IBillingService,
  IComputeDeviceResolver,
  IConfigService,
  IBlobStorageService,
  IEntitlementsService,
  IMediaService,
  ITenantBucketService,
  IUsageLedgerService,
  LlmStreamUsageCollector,
  requestedLanguageMode,
  resolveEffectiveLanguageMode,
  SecretsService,
  TranscriptionJobService,
  TenantSettingsService,
  TranscriptionRealtimeService,
  TtsAgentResolverService,
  UsageIdempotencyKey,
  appendComputeAndByteUnits,
  buildGuardrailUsageBatches,
  buildLlmUsageBatches,
  buildLlmUsageBatchesFromTokenCounts,
  buildNerUsageEvent,
  classifyLlmDeployment,
  parseTextUsageDetail,
  resolveDeployment,
  toLedgerProvider,
  withUsageAttributes,
  withUsageTrigger,
  requestIdHeader,
} from '@arcaai/applications';
import type {
  AgentNerEntity,
  AgentNerInvocationResult,
  AgentTextInvocationResult,
  ByteSource,
  ComputeAugmentedBatch,
  ComputeDevice,
  GuardrailDisposition,
  IBlobStorageService as IBlobStorageServiceType,
  ResolvedAgent,
  UsageAttributes,
  UsageEventBatchInput,
} from '@arcaai/applications';
import { AiCapability, AiCostBasis, AiDeploymentKind, AiUsageUnit, generateId } from '@arcaai/domains';
import { HttpService } from '@nestjs/axios';
import {
  BadRequestException,
  Body,
  ConflictException,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Logger,
  Optional,
  Param,
  Post,
  Query,
  Req,
  Res,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ApiBearerAuth, ApiBody, ApiHeader, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { AxiosError } from 'axios';
import type { Request, Response } from 'express';
import {
  RUN_EVENTS_KEY,
  RUN_PROTOCOL_HEADER,
  RUN_PROTOCOL_QUERY_PARAM,
  TERMINAL_RUN_EVENT_TYPES,
  parseResumeCursor,
  parseStoredRunEvent,
  planRunResume,
  selectRunProtocol,
  toPublicRunEvent,
  toSseFrame,
  type RunEventV2,
  type RunResyncReason,
} from '@arcaai/async-contract';
import { ClsService } from 'nestjs-cls';
import { RequiredScopes, RequiredSvcScopes } from '../../decorators';
import { classifyDownstreamFailure, downstreamStatusFor } from '../../filters/downstream-error';
import { recordUsageEmissionFailure } from '../../observability/usage-emission-metric';
import { classifyTtsProvider, isAttributableTtsProvider } from '../speech/tts-provider-classification';
import { RunEventStreamHub } from '../workflows/run-event-stream-hub';
import { AgentRunService, agentRunLinks, type AgentRunOutcome } from './agent-run.service';
import { persistSpeechBlob, type SpeechBlobFormat } from './tts-blob-delivery';
import type { AgentRunTask } from './agent-run.store';
import { AgentTranscriptionRequest } from './dto/agent-transcription.request';

/** Plain interfaces (not class-validator DTOs) so the global pipe passes the body through; TIER 3 validation runs against the agent's own `inputSchema`. */
export interface AgentInvocationBody {
  /** TASK-1036 OD-8 — the user turn. */
  message?: string;
  /** @deprecated TASK-1036 OD-8 — alias of `message`, accepted for one release. */
  text?: string;
  variables?: Record<string, string>;
  /**
   * TASK-890 §3.3/§3.4 — the run CONTEXT, validated against the agent's BOUND context schema and
   * NOT against `inputSchema`. They are different declarations of different things: `inputSchema`
   * says what this agent is called WITH, the context schema says what it is called ABOUT.
   */
  context?: Record<string, unknown>;
  [key: string]: unknown;
}
export interface AgentSpeechBody {
  text?: string;
  ssml?: string;
  /**
   * TASK-1036 §3.2 — `stream` (the default: the audio itself, streamed) or `blob` (stored in the
   * tenant bucket; the answer is `{ mediaId, url, expiresAt, format, sampleRate, durationMs }`).
   */
  delivery?: 'stream' | 'blob';
}

export interface AgentTextInvocationResponse {
  agentSlug: string;
  agentVersionId: string;
  output: { text: string };
  provider: string | null;
  model: string | null;
  usage: { promptTokens: number | null; completionTokens: number | null } | null;
  /**
   * TASK-947 (OD-11) — which prompt fragments of a COMPOSITE instruction this call ran, KEYS
   * only; `null` for the two single-body forms. Never a condition string or a fragment body.
   */
  promptFragments: { selected: string[] } | null;
}

/**
 * TASK-930 §2.4 — the NER answer, in the SAME envelope as the text one so a caller reads
 * `agentSlug` / `agentVersionId` / `output` identically whichever task the slug resolves to.
 * `output` is the agent's declared output schema verbatim (`{ entities }`).
 */
export interface AgentNerInvocationResponse {
  agentSlug: string;
  agentVersionId: string;
  output: { entities: AgentNerEntity[] };
  provider: string | null;
  model: string | null;
  usage: null;
}

export interface AgentTranscriptionResponse {
  id: string;
  status: string;
  agentSlug: string;
  agentVersionId: string;
  sseUrl: string;
}

const SSE_HEARTBEAT_INTERVAL_MS = 15_000;

/** The blob's format: what `apps/tts` reported, else what was asked for, else the content type. */
function speechBlobFormat(reported: unknown, requested: unknown, contentType: string): SpeechBlobFormat {
  const known = (value: unknown): value is SpeechBlobFormat => value === 'wav' || value === 'mp3' || value === 'pcm' || value === 'ogg';
  if (known(reported)) return reported;
  if (known(requested)) return requested;
  if (contentType.includes('wav')) return 'wav';
  if (contentType.includes('mpeg')) return 'mp3';
  if (contentType.includes('ogg')) return 'ogg';
  return 'pcm';
}

/** The persisted terminal statuses of a run. */
const TERMINAL_STATUSES: ReadonlySet<string> = new Set(['COMPLETED', 'FAILED', 'CANCELED', 'TIMED_OUT']);

/** TASK-1038 OD-26 — what `POST /agents/:slug/runs` answers. */
export interface AgentRunStartResponse {
  runId: string;
  status: string;
  links: { self: string; events: string; result: string; cancel: string };
}

/** TASK-1038 OD-26 — `GET /agents/:slug/runs/:runId`. */
export interface AgentRunStatusResponse {
  runId: string;
  agentSlug: string;
  agentVersionId: string;
  versionNumber: number;
  status: string;
  createdAt: string;
  endedAt: string | null;
  durationMs: number | null;
  error: { code: string; message: string } | null;
  links: { self: string; events: string; result: string; cancel: string };
}

/**
 * Every ledger row this controller writes names the activity that produced it
 * (TASK-890 OD-E). All three routes here ARE the agent business plane, so the
 * value is a constant rather than a parameter — a caller cannot claim to be
 * something else.
 */
const AGENT_INVOCATION_TRIGGER = 'AGENT_INVOCATION' as const;

/**
 * TASK-959 — a positive number off an untyped upstream block, or `null`.
 *
 * Every metering reading in this file goes through it, and it refuses zero as well as absent:
 * a reading of zero is a measurement that says "no time, no bytes", and a row recording that is
 * a row saying nothing happened.
 */
function positiveNumber(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

/**
 * TASK-959 §3.1 — `X-Tts-Device`, from the CLOSED vocabulary only.
 *
 * ABSENT is a real answer and the common one: `apps/tts` omits the header for a cloud engine
 * that runs on nobody's hardware of ours (Azure, Sarvam). `null` records no compute row, because
 * a platform CPU/GPU second on a vendor's synthesis is a cost the platform never paid.
 */
function computeDeviceHeader(value: unknown): ComputeDevice | null {
  return typeof value === 'string' && (COMPUTE_DEVICES as readonly string[]).includes(value) ? (value as ComputeDevice) : null;
}

/** TASK-959 §4.2 — `X-Tts-Byte-Source`, from the closed vocabulary only. */
function byteSourceHeader(value: unknown): ByteSource | null {
  return value === 'wire' || value === 'app' ? value : null;
}

/**
 * AgentController — the Agent BUSINESS plane (TASK-863 §3.5), mounted at `/agents`
 * (global prefix -> `/api/v1/agents`). API key or JWT; every route pairs an authorization
 * decorator (the deny-by-default boot audit) with `@RequiredScopes` (the API-key gate).
 *
 * TASK-930 §3 — service accounts ARE now admitted, through the fourth `svc:` family
 * (`AGENT_WORKFLOW_BUSINESS_PLANE_SCOPE_SOURCES`): `svc:agent:definition:read` reads the
 * published catalogue and `svc:agent:invocation:write` runs it. The scopes are DERIVED from the
 * API-key scopes gating the same routes, so a machine identity reaches exactly what a
 * human-delegated key reaches and not one route more. A service account binds its
 * `workingTenantId` at token EXCHANGE, so it never sends `X-Tenant-Id` here.
 *
 * Every route resolves the agent through the ONE resolver the harness also uses, then
 * executes through the EXISTING service paths: `apps/text` `/generate` (via
 * `AgentInvocationService`), the TTS speech proxy contract, and the batch transcription job.
 */
@ApiBearerAuth()
@ApiTags('agents')
@Controller('agents')
export class AgentController {
  private readonly logger = new Logger(AgentController.name);

  constructor(
    @Inject(IAgentService) private readonly agentService: IAgentService,
    private readonly resolver: AgentResolverService,
    private readonly invocation: AgentInvocationService,
    private readonly cls: ClsService<IActiveUserContext>,
    private readonly httpService: HttpService,
    @Inject(IConfigService) private readonly configService: IConfigService,
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
    // TASK-879 — the ONE TEXT_TO_SPEECH resolution. This route has ALREADY resolved the agent
    // (that is what it is), so it calls `resolveFromAgent` rather than re-running the cascade:
    // resolving twice could pick a different version between the two reads.
    @Optional() private readonly ttsResolver?: TtsAgentResolverService,
    @Optional() @Inject(IEntitlementsService) private readonly entitlementsService?: IEntitlementsService,
    @Optional() @Inject(IUsageLedgerService) private readonly usageLedger?: IUsageLedgerService,
    @Optional() private readonly jobService?: TranscriptionJobService,
    @Optional() private readonly realtimeService?: TranscriptionRealtimeService,
    @Optional() @Inject(IMediaService) private readonly mediaService?: IMediaService,
    // TASK-861 — the ONE STT resolution (agent → ResolvedAsrSpec + credentials);
    // the batch `transcriptions` route needs no pipeline row any more.
    @Optional() private readonly asrResolver?: AsrAgentResolverService,
    // TASK-957 F-4 — the tenant's OPTIONAL monthly spend ceiling (D12). It was enforced on
    // consultation summaries only, so the two planes that can spend fastest — agent invocations
    // and workflow runs — were unbounded for a tenant that had explicitly set a cap. Optional and
    // trailing like every other cross-cutting dependency here: absent = not enforced, which is
    // what a minimal fixture and a gateway without the billing module get.
    @Optional() @Inject(IBillingService) private readonly billing?: IBillingService,
    // TASK-959 §3.1 — which device a self-hosted LLM server runs on, the one thing `apps/text`
    // cannot report about itself (it is stateless per call and no request or model row carries a
    // device). The SHARED resolver, not a local read of the same descriptor: it already owns the
    // tenant → SYSTEM cascade, the membership check and the warn-once, and it never raises —
    // unresolvable degrades to `cpu` rather than to a lost usage batch.
    @Optional() @Inject(IComputeDeviceResolver) private readonly computeDevice?: IComputeDeviceResolver,
    // TASK-1038 OD-26 — the agent RUN resource. Trailing and @Optional() like everything above;
    // absent ⇒ the run routes answer a named 503 and the invocation routes are untouched.
    @Optional() private readonly agentRuns?: AgentRunService,
    // TASK-1038 R-1 — the process-wide multiplexed run-stream reader (@Global, exported by
    // `WorkflowRunCompletionModule`), read through its existing API for `…/runs/:runId/events`.
    @Optional() private readonly runEventHub?: RunEventStreamHub,
    // TASK-1036 §3.2 — `delivery: 'blob'` on `/speech`: the tenant's AUDIO bucket, the store
    // that writes to it (@Global), and the signed-URL lifetime (`workflowRuns.resultUrlTtlSeconds`).
    @Optional() @Inject(ITenantBucketService) private readonly tenantBuckets?: ITenantBucketService,
    @Optional() @Inject(IBlobStorageService) private readonly blobStorage?: IBlobStorageServiceType,
    @Optional() private readonly tenantSettings?: TenantSettingsService,
  ) {}

  @Get()
  @Authorize()
  @RequiredScopes('agent:definition:read')
  @RequiredSvcScopes('svc:agent:definition:read')
  @ApiOperation({ summary: 'List the published agents visible to the tenant (own agents shadow the platform defaults)' })
  @ApiQuery({ name: 'task', required: false, enum: AgentTask })
  @ApiResponse({ status: 200, type: AgentSummaryListResponse })
  async list(@Query('task') task?: AgentTask): Promise<AgentSummaryListResponse> {
    return { data: await this.agentService.listPublished(task) };
  }

  @Get(':slug')
  @Authorize()
  @RequiredScopes('agent:definition:read')
  @RequiredSvcScopes('svc:agent:definition:read')
  @ApiOperation({ summary: 'Describe one published agent: its task, version and I/O schemas' })
  @ApiParam({ name: 'slug', type: String })
  @ApiResponse({ status: 200, type: AgentSummaryResponse })
  @ApiResponse({ status: 404, description: 'Unknown, unpublished, or another tenant’s agent — one answer.' })
  async get(@Param('slug') slug: string): Promise<AgentSummaryResponse> {
    return this.agentService.getPublishedBySlug(slug);
  }

  @Post(':slug/invocations')
  @HttpCode(HttpStatus.OK)
  @Authorize()
  @RequiredScopes('agent:invocation:write')
  @RequiredSvcScopes('svc:agent:invocation:write')
  @Throttle({ heavy: { limit: 20, ttl: 60000 } })
  @ApiOperation({
    summary: 'Invoke a TEXT_GENERATION agent (blocking JSON, or SSE with ?mode=stream)',
    description:
      'The body is validated against the agent’s `inputSchema` (default: `{ message } | { text } | { variables }` — `text` is a deprecated alias of `message`). `mode=blocking` answers `200 application/json`; ' +
      '`mode=stream` answers `200 text/event-stream` with the TEXT service’s frames relayed verbatim.',
  })
  @ApiParam({ name: 'slug', type: String })
  @ApiQuery({ name: 'mode', required: false, enum: ['blocking', 'stream'] })
  // TASK-971 (F-F1) — DOCUMENTED, not validated here. `AgentInvocationBody` is a plain
  // interface rather than a class-validator DTO precisely so the global pipe's
  // `forbidNonWhitelisted` does NOT run on it: the agent's own `inputSchema` is the
  // validator (TIER 3), and it may declare fields this gateway has never heard of. Turning
  // it into a DTO to make the Swagger plugin emit a body would break every such agent — so
  // the shape is described here instead, with the agent's schema named as the authority.
  @ApiBody({
    required: true,
    description:
      'FLAT — `{ message, … }`, never `{ input: { … } }`. (The enveloped form is the WORKFLOW body, `POST /workflows/{slug}/runs`; getting the two the wrong way round is a 400 on every call.) ' +
      'The properties below are the DEFAULT `inputSchema` a TEXT_GENERATION agent ships with. What is actually accepted is the agent’s OWN `inputSchema`, published by `GET /api/v1/agents/{slug}` — ' +
      'which is why additional properties are allowed here and why a mismatch is a 400 rather than a 422. ' +
      'A NAMED_ENTITY_RECOGNITION agent shares this route and this body, but is one-shot: `?mode=stream` on one answers 400 `MODE_UNSUPPORTED`.',
    schema: {
      type: 'object',
      additionalProperties: true,
      properties: {
        message: {
          type: 'string',
          description:
            'The user turn (TASK-1036 OD-8). Optional: a body may carry only `variables`. An agent that declares its own schema may name something else entirely.',
        },
        text: {
          type: 'string',
          deprecated: true,
          description: 'DEPRECATED alias of `message`, accepted for one release. Send `message`.',
        },
        variables: {
          type: 'object',
          additionalProperties: { type: 'string' },
          description: 'Values substituted into the agent’s prompt template.',
        },
        context: {
          type: 'object',
          additionalProperties: true,
          description:
            'The run CONTEXT, validated against the context schema the agent BINDS — not against `inputSchema`. They declare different things: `inputSchema` says what the agent is called WITH, the context schema says what it is called ABOUT. A violation is a 400 `CONTEXT_SCHEMA_VIOLATION`.',
        },
      },
      example: { message: 'Summarise the consultation note below.' },
    },
  })
  @ApiResponse({ status: 200, description: 'The generated output (JSON) or the SSE stream.' })
  @ApiResponse({
    status: 400,
    description:
      'The body does not match the agent’s inputSchema, the `context` does not satisfy the schema the agent binds ' +
      '(`CONTEXT_SCHEMA_VIOLATION`), the agent is not a TEXT_GENERATION agent, or — for a service-account caller on an ' +
      'agent whose schema declares a user-identity field — the supplied staff identifier is unusable ' +
      '(`USER_IDENTITY_INVALID`) or no department could be resolved to provision the clinician in ' +
      '(`USER_IDENTITY_DEPARTMENT_UNRESOLVED`).',
  })
  @ApiResponse({
    status: 404,
    description:
      'Unknown, unpublished, or another tenant’s agent — one answer. Also the answer when a service-account caller ' +
      'supplies a staff identifier this tenant does not have (`USER_IDENTITY_UNKNOWN`) or whose user cannot act ' +
      '(`USER_IDENTITY_NOT_USABLE`).',
  })
  // TASK-950 — the schema-declared user-identity refusals. Documented on the route because an
  // integrator meets them as HTTP statuses long before it meets the resolver; the CODE is what
  // says which of the four 4xx families it landed in.
  @ApiResponse({
    status: 409,
    description:
      'The context schema declares a user-identity field and the supplied staff identifier is ambiguous ' +
      '(`USER_IDENTITY_AMBIGUOUS` — more than one user in this tenant carries it), or provisioning a new ' +
      'user would exceed the tenant’s `maxUsers` allowance. Service-account callers only.',
  })
  @ApiResponse({
    status: 503,
    description:
      'The identity resolver is not configured, so a request that names a clinician cannot be honoured (`USER_IDENTITY_RESOLVER_UNAVAILABLE`).',
  })
  @ApiResponse({
    status: 429,
    description: 'The tenant has reached its `monthlyLlmTokens` allowance. Refused before the model runs, so nothing is billed.',
  })
  // TASK-957 F-4 — the tenant's own monthly spend ceiling (D12). Documented on every metered
  // route here because an integrator meets it as an HTTP status long before it meets the
  // billing plane, and 402 is a refusal no retry resolves.
  @ApiResponse({
    status: 402,
    description: 'The tenant has reached the monthly spend limit it set (`monthlySpendLimitMicros`). Refused before anything is spent.',
  })
  async invoke(@Param('slug') slug: string, @Body() body: AgentInvocationBody, @Res() res: Response, @Query('mode') mode?: string): Promise<void> {
    const tenantId = this.requireTenant();
    // TASK-930 §2.4 — resolved WITHOUT a task pin, then dispatched on the agent's own task.
    // Pinning TEXT_GENERATION here would have made a NER agent unreachable through the ONE route
    // it publishes, and the refusal would have named the wrong thing ("this call needs
    // TEXT_GENERATION") for a caller who asked for exactly what it published.
    const resolved = await this.resolver.resolve({ tenantId, agentSlug: slug });
    if (resolved.task === AgentTask.NAMED_ENTITY_RECOGNITION) {
      await this.invokeNer(resolved, tenantId, slug, body, res, mode);
      return;
    }
    // `context` is checked against the agent's FROZEN context schema inside `invokeText`, not
    // against `inputSchema` — so it is withheld from this check. Without that, the two
    // declarations collide: every default `inputSchema` is `additionalProperties: false` and
    // declares only `{ text, variables }`, so an agent that PINS a context schema could never be
    // invoked with a context at all, and §3.4's enforcement path was unreachable through the
    // route that is supposed to reach it.
    await this.precheckText(resolved, tenantId, body);

    // How this call was screened, stamped on whichever row the call ends up producing (the stream
    // path emits from three handlers). Every call is screened: the opt-out and the platform kill
    // switch are retired.
    const guardrail: GuardrailDisposition = 'screened';

    if (mode === 'stream') {
      await this.streamText(resolved, tenantId, slug, body, res, guardrail);
      return;
    }

    res.status(HttpStatus.OK).json(await this.executeText(resolved, tenantId, slug, body));
  }

  /**
   * TIER 3 input validation + the metered prechecks of a TEXT_GENERATION call — shared by the
   * invocation route and the run route (TASK-1038 OD-26), so a run is refused for exactly the
   * reasons an invocation is, and BEFORE its 202.
   */
  private async precheckText(resolved: ResolvedAgent, tenantId: string, body: AgentInvocationBody): Promise<void> {
    const { context: _context, ...invocationInput } = body ?? {};
    const problems = this.invocation.inputProblems(resolved, invocationInput);
    if (problems.length > 0) throw new BadRequestException({ message: 'The invocation body does not match the agent’s inputSchema.', problems });

    // TASK-890 (BLOCKER #7) — the LLM-token allowance, BEFORE the expensive
    // call, exactly as `speech()` below has always gated `monthlyTtsCharacters`.
    // Post-hoc debit (D6): this call's token count is unknowable until TEXT
    // answers, so the check compares month-to-date rollups against the
    // allowance rather than predicting this call — the same call shape
    // `summary.service.ts` uses. Kill-switch-gated inside; → 429 when over.
    await this.entitlementsService?.assertMeterQuota(tenantId, 'monthlyLlmTokens');
    // TASK-957 F-4 — and the tenant's optional monthly SPEND ceiling (D12), which the meter above
    // cannot express: a meter caps a QUANTITY of one unit, the ceiling caps MONEY across all of
    // them. Enforced on consultation summaries only until now, so a tenant that set a cap was
    // unbounded on the two planes that can spend fastest. Opt-in and cheap: a tenant with no
    // limit set returns without computing a draft. -> 402 when over.
    await this.billing?.assertSpendLimit(tenantId);
  }

  private async streamText(
    resolved: ResolvedAgent,
    tenantId: string,
    slug: string,
    body: AgentInvocationBody,
    res: Response,
    guardrail: GuardrailDisposition,
  ): Promise<void> {
    const { stream, actingUserId } = await this.invocation.invokeText(resolved, tenantId, body ?? {}, 'stream');
    // TASK-950 (decision 3, fast win) — the clinician this call acted FOR, on every row the
    // three teardown handlers below can emit. `AgentInvocationService` writes no row and
    // broadcasts no event, so the usage ledger is this plane's ONLY durable, queryable record;
    // `doctorId` is the column consultation-driven calls already fill, so both arrive on one
    // channel rather than two. `null` for a human or API-key caller, exactly as today.
    const doctorId = actingUserId ?? null;
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('X-Agent-Slug', resolved.slug);
    res.setHeader('X-Agent-Version-Id', resolved.agentVersionId);
    res.flushHeaders();
    const heartbeat = setInterval(() => res.write(':keepalive\n\n'), SSE_HEARTBEAT_INTERVAL_MS);
    // Forward first, observe from a side copy: the client's bytes are never
    // touched by metering (§3.13 — the ONE tee, `LlmStreamUsageCollector`).
    const collector = new LlmStreamUsageCollector();
    stream.on('data', (chunk: Buffer) => {
      res.write(chunk);
      collector.observe(chunk);
    });
    stream.on('end', () => {
      clearInterval(heartbeat);
      res.end();
      void this.emitStreamInvocationUsage(collector, { tenantId, doctorId }, slug, guardrail);
    });
    stream.on('error', (err: Error) => {
      clearInterval(heartbeat);
      this.logger.error({ message: 'Agent invocation stream error', agentSlug: slug, error: err.message });
      res.end();
      // The tokens seen before the socket died were still spent.
      void this.emitStreamInvocationUsage(collector, { tenantId, doctorId, interrupted: true }, slug, guardrail);
    });
    res.on('close', () => {
      clearInterval(heartbeat);
      stream.destroy();
      void this.emitStreamInvocationUsage(collector, { tenantId, doctorId, interrupted: true }, slug, guardrail);
    });
  }

  /** One blocking TEXT_GENERATION call, metered — the invocation route's answer and a run's execution. */
  private async executeText(
    resolved: ResolvedAgent,
    tenantId: string,
    slug: string,
    body: AgentInvocationBody,
  ): Promise<AgentTextInvocationResponse> {
    const guardrail: GuardrailDisposition = 'screened';
    const result = await this.invocation.invokeText(resolved, tenantId, body ?? {}, 'blocking');
    this.emitInvocationUsage(await this.buildBlockingUsage(tenantId, resolved, result), slug, guardrail);
    // TASK-957 F-3 — a SEPARATE row for the screening call TEXT made on this request's behalf.
    // Its own operation, its own key, its own model: it is another provider call, not a dimension
    // of the generation. No `guardrail` disposition on it — the dimension records how a
    // GENERATION was screened, and stamping it on the screening call itself would be circular.
    this.emitInvocationUsage(await this.buildBlockingGuardrailUsage(tenantId, result), slug);
    const payload: AgentTextInvocationResponse = {
      agentSlug: resolved.slug,
      agentVersionId: resolved.agentVersionId,
      output: { text: result.text },
      provider: result.provider,
      model: result.model,
      usage: result.usage,
      promptFragments: result.promptFragments ?? null,
    };
    return payload;
  }

  /**
   * TASK-930 §2.4 — the NER half of `POST /agents/:slug/invocations`.
   *
   * One-shot by construction: `apps/nlp` classifies the whole document in a single pass, so
   * `?mode=stream` is REFUSED with a named code rather than degraded to a blocking answer — a
   * caller that opened an SSE reader against a silent one-shot route would simply hang, and a
   * 400 that says why is the only honest reply to a mode the agent never offers.
   *
   * Metered like every other inference activity (OD-E): the `monthlyNlpTextUnits` allowance is
   * checked BEFORE the call (nothing is billed for a refused one), and the row is the SAME
   * `ner.extract` shape the two clinical NER call sites and the playground proxy already write,
   * so an agent invocation appears in the tenant's NLP rollup rather than in a fourth vocabulary.
   */
  private async invokeNer(
    resolved: ResolvedAgent,
    tenantId: string,
    slug: string,
    body: AgentInvocationBody,
    res: Response,
    mode?: string,
  ): Promise<void> {
    if (mode === 'stream') {
      throw new BadRequestException({
        message: `Agent '${resolved.slug}' performs NAMED_ENTITY_RECOGNITION, a one-shot task with nothing to stream. Re-send without \`mode=stream\`.`,
        code: 'MODE_UNSUPPORTED',
      });
    }
    await this.precheckNer(resolved, tenantId, body);
    res.status(HttpStatus.OK).json(await this.executeNer(resolved, tenantId, slug, body));
  }

  private async precheckNer(resolved: ResolvedAgent, tenantId: string, body: AgentInvocationBody): Promise<void> {
    const { context: _context, ...invocationInput } = body ?? {};
    const problems = this.invocation.inputProblems(resolved, invocationInput);
    if (problems.length > 0) throw new BadRequestException({ message: 'The invocation body does not match the agent’s inputSchema.', problems });

    await this.entitlementsService?.assertMeterQuota(tenantId, 'monthlyNlpTextUnits');
    // TASK-957 F-4 — the same ceiling. NER shares the invocations route, so a plane that checked
    // only the TEXT_GENERATION branch would leave half of it unbounded.
    await this.billing?.assertSpendLimit(tenantId);
  }

  private async executeNer(resolved: ResolvedAgent, tenantId: string, slug: string, body: AgentInvocationBody): Promise<AgentNerInvocationResponse> {
    const result = await this.invocation.invokeNer(resolved, tenantId, body ?? {});
    this.emitInvocationUsage(this.buildNerUsage(tenantId, result), slug);

    const payload: AgentNerInvocationResponse = {
      agentSlug: resolved.slug,
      agentVersionId: resolved.agentVersionId,
      output: { entities: result.entities },
      // Always the platform's own token-classification runtime: a NER agent resolves no
      // provider connection at all (`compiledConfig.service` is null), so there is no vendor
      // to attribute and the catalogue row's own provider is the whole truth.
      provider: resolved.compiledConfig.model.provider ?? null,
      model: result.model,
      usage: null,
    };
    return payload;
  }

  // ============================================================================================
  // TASK-1038 OD-26 — the agent RUN resource (`invocations` stays as the synchronous sugar)
  // ============================================================================================

  @Post(':slug/runs')
  @HttpCode(HttpStatus.ACCEPTED)
  @Authorize()
  @RequiredScopes('agent:invocation:write')
  @RequiredSvcScopes('svc:agent:invocation:write')
  @Throttle({ heavy: { limit: 20, ttl: 60000 } })
  @ApiOperation({
    summary: 'Start an agent RUN (async): answers 202 { runId, status, links } at once; poll, read the result, or follow its events',
    description:
      'The same body, validation and metering as `POST /agents/{slug}/invocations` (TEXT_GENERATION and NAMED_ENTITY_RECOGNITION agents), ' +
      'refused BEFORE the 202 when invalid or over quota. The agent then runs in the background. `links.events` streams the run as run ' +
      'protocol v2 (SSE, resumable); `links.result` serves the output once it is terminal. **Idempotency**: send `Idempotency-Key` — the ' +
      'same key with the same body joins the run it started (same `runId`, the agent runs once); the same key with a different body is 409.',
  })
  @ApiParam({ name: 'slug', type: String })
  @ApiHeader({ name: 'Idempotency-Key', required: false, description: 'Retry-safe key. The same key + the same body joins the existing run.' })
  @ApiBody({
    required: true,
    description: 'The invocation body (see `POST /agents/{slug}/invocations`).',
    schema: { type: 'object', additionalProperties: true },
  })
  @ApiResponse({ status: 202, description: '`{ runId, status, links: { self, events, result, cancel } }`.' })
  @ApiResponse({
    status: 400,
    description: 'The body does not match the agent’s inputSchema, or the agent’s task has no run form (use `/speech` or `/transcriptions`).',
  })
  @ApiResponse({ status: 404, description: 'Unknown, unpublished, or another tenant’s agent — one answer.' })
  @ApiResponse({ status: 409, description: '`IDEMPOTENCY_KEY_REUSED` — the key already started a run with a different body.' })
  @ApiResponse({ status: 429, description: 'The tenant has reached its usage allowance. Refused before anything runs.' })
  @ApiResponse({ status: 503, description: '`AGENT_RUN_STORE_UNAVAILABLE` — the run store is not reachable.' })
  async startRun(
    @Param('slug') slug: string,
    @Body() body: AgentInvocationBody,
    @Headers('Idempotency-Key') idempotencyKey?: string,
  ): Promise<AgentRunStartResponse> {
    const runs = this.requireRuns();
    const tenantId = this.requireTenant();
    const resolved = await this.resolver.resolve({ tenantId, agentSlug: slug });
    let execute: () => Promise<AgentRunOutcome>;
    if (resolved.task === AgentTask.TEXT_GENERATION) {
      await this.precheckText(resolved, tenantId, body);
      execute = async () => {
        const answer = await this.executeText(resolved, tenantId, slug, body);
        return {
          output: answer.output,
          tokens: { in: answer.usage?.promptTokens ?? 0, out: answer.usage?.completionTokens ?? 0 },
        };
      };
    } else if (resolved.task === AgentTask.NAMED_ENTITY_RECOGNITION) {
      await this.precheckNer(resolved, tenantId, body);
      execute = async () => ({ output: (await this.executeNer(resolved, tenantId, slug, body)).output, tokens: { in: 0, out: 0 } });
    } else {
      throw new BadRequestException({
        message: `Agent '${resolved.slug}' is a ${resolved.task} agent; a run applies to TEXT_GENERATION and NAMED_ENTITY_RECOGNITION agents. Use its own route (\`/speech\`, \`/transcriptions\`).`,
        code: 'RUN_TASK_UNSUPPORTED',
      });
    }
    const key = typeof idempotencyKey === 'string' && idempotencyKey.length > 0 ? idempotencyKey : undefined;
    const { state } = await runs.start({
      tenantId,
      slug: resolved.slug,
      agentVersionId: resolved.agentVersionId,
      versionNumber: resolved.versionNumber,
      task: resolved.task as AgentRunTask,
      body: body ?? {},
      idempotencyKey: key,
      execute,
    });
    return { runId: state.runId, status: state.status, links: agentRunLinks(state.slug, state.runId) };
  }

  @Get(':slug/runs/:runId')
  @Authorize()
  @RequiredScopes('agent:invocation:write')
  @RequiredSvcScopes('svc:agent:invocation:write')
  @ApiOperation({ summary: 'The status of one agent run' })
  @ApiParam({ name: 'slug', type: String })
  @ApiParam({ name: 'runId', type: String })
  @ApiResponse({ status: 200, description: 'The run: status, timings, the public error of a failed run, and its links.' })
  @ApiResponse({ status: 404, description: 'Another tenant’s run, or a runId that does not belong to this agent — one answer.' })
  async getRun(@Param('slug') slug: string, @Param('runId') runId: string): Promise<AgentRunStatusResponse> {
    const state = await this.requireRuns().get(this.requireTenant(), slug, runId);
    return {
      runId: state.runId,
      agentSlug: state.slug,
      agentVersionId: state.agentVersionId,
      versionNumber: state.versionNumber,
      status: state.status,
      createdAt: state.createdAt,
      endedAt: state.endedAt,
      durationMs: state.durationMs,
      error: state.error,
      links: agentRunLinks(state.slug, state.runId),
    };
  }

  @Get(':slug/runs/:runId/result')
  @Authorize()
  @RequiredScopes('agent:invocation:write')
  @RequiredSvcScopes('svc:agent:invocation:write')
  @ApiOperation({
    summary: 'The output a finished agent run produced',
    description:
      'Mirrors `GET /workflows/{slug}/runs/{runId}/result`: 200 with `X-Hope-Result-Kind: inline` and the agent output as the body ' +
      '(`{ text }` / `{ entities }`); 204 when the run ended without one (failed or cancelled); 409 `RUN_NOT_TERMINAL` while it runs.',
  })
  @ApiParam({ name: 'slug', type: String })
  @ApiParam({ name: 'runId', type: String })
  @ApiResponse({ status: 200, description: 'The agent output.' })
  @ApiResponse({ status: 204, description: 'The run is terminal and produced no output.' })
  @ApiResponse({ status: 404, description: 'Another tenant’s run, or a runId that does not belong to this agent.' })
  @ApiResponse({ status: 409, description: '`RUN_NOT_TERMINAL` — the run has not finished; the body carries its status.' })
  async getRunResult(@Param('slug') slug: string, @Param('runId') runId: string, @Res({ passthrough: true }) res: Response): Promise<unknown> {
    const state = await this.requireRuns().get(this.requireTenant(), slug, runId);
    if (state.status === 'RUNNING') {
      throw new ConflictException({ code: 'RUN_NOT_TERMINAL', message: `Run '${runId}' has not finished.`, status: state.status });
    }
    if (state.status === 'COMPLETED' && state.output) {
      res.setHeader('X-Hope-Result-Kind', 'inline');
      return state.output;
    }
    res.status(HttpStatus.NO_CONTENT);
    return undefined;
  }

  @Post(':slug/runs/:runId/cancel')
  @HttpCode(HttpStatus.OK)
  @Authorize()
  @RequiredScopes('agent:invocation:write')
  @RequiredSvcScopes('svc:agent:invocation:write')
  @ApiOperation({
    summary: 'Cancel an agent run (idempotent)',
    description:
      'A RUNNING run becomes CANCELED and its stream ends with `run.cancelled`; a finished run is answered as it is. A model call already in ' +
      'flight is not interrupted — its output is discarded, and it is still metered because it was spent.',
  })
  @ApiParam({ name: 'slug', type: String })
  @ApiParam({ name: 'runId', type: String })
  @ApiResponse({ status: 200, description: '`{ runId, status }` after the cancel.' })
  @ApiResponse({ status: 404, description: 'Another tenant’s run, or a runId that does not belong to this agent.' })
  async cancelRun(@Param('slug') slug: string, @Param('runId') runId: string): Promise<{ runId: string; status: string }> {
    const state = await this.requireRuns().cancel(this.requireTenant(), slug, runId);
    return { runId: state.runId, status: state.status };
  }

  @Get(':slug/runs/:runId/events')
  @Authorize()
  @RequiredScopes('agent:invocation:write')
  @RequiredSvcScopes('svc:agent:invocation:write')
  @ApiOperation({
    summary: 'Follow an agent run as run protocol v2 over SSE (resumable)',
    description:
      'Every frame is `event: <type>` / `id: <seq>` / `data: <envelope>`; the step is `nodeId: "agent"`. Resume with `Last-Event-ID` ' +
      '(or `?after=<seq>`); a cursor the server can no longer serve is answered with `run.resync` and a snapshot. The stream ends after ' +
      'the terminal event. Agent runs speak protocol 2 only: `?protocol=` / `x-hope-run-protocol` may be omitted or `2`.',
  })
  @ApiParam({ name: 'slug', type: String })
  @ApiParam({ name: 'runId', type: String })
  @ApiQuery({ name: 'after', required: false, description: 'Resume after this seq (the header `Last-Event-ID` wins).' })
  @ApiQuery({ name: 'protocol', required: false, enum: ['2'] })
  @ApiResponse({ status: 200, description: '`text/event-stream` of run protocol v2 frames.' })
  @ApiResponse({ status: 400, description: 'An unsupported protocol, or a malformed resume cursor.' })
  @ApiResponse({ status: 404, description: 'Another tenant’s run, or a runId that does not belong to this agent.' })
  async runEvents(@Param('slug') slug: string, @Param('runId') runId: string, @Req() req: Request, @Res() res: Response): Promise<void> {
    const runs = this.requireRuns();
    const tenantId = this.requireTenant();
    const header = (name: string): string | undefined => {
      const value = req.headers?.[name];
      return Array.isArray(value) ? value[0] : value;
    };
    const query = (name: string): string | undefined => {
      const value = (req.query as Record<string, unknown> | undefined)?.[name];
      return typeof value === 'string' ? value : undefined;
    };
    const protocol = selectRunProtocol({ header: header(RUN_PROTOCOL_HEADER), query: query(RUN_PROTOCOL_QUERY_PARAM) });
    if ('problems' in protocol) throw new BadRequestException({ code: 'RUN_PROTOCOL_UNSUPPORTED', message: protocol.problems.join('; ') });
    const cursor = parseResumeCursor({ lastEventId: header('last-event-id'), after: query('after') });
    if ('problems' in cursor) throw new BadRequestException({ code: 'RUN_CURSOR_INVALID', message: cursor.problems.join('; ') });
    // Existence first (404-over-403), before a single header is written.
    let state = await runs.get(tenantId, slug, runId);

    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();
    const abort = new AbortController();
    res.on('close', () => abort.abort());

    const write = (event: RunEventV2): void => void res.write(toSseFrame(event));
    const resync = async (reason: RunResyncReason, lastSeq: number): Promise<void> => {
      state = await runs.get(tenantId, slug, runId);
      write({
        seq: lastSeq,
        runId,
        type: 'run.resync',
        ts: new Date().toISOString(),
        data: { reason, snapshot: runs.snapshotOf(state, lastSeq) },
      } as RunEventV2);
    };

    const hub = this.runEventHub;
    if (!hub || !hub.available()) {
      // swallow-ok: the push transport is already down; the snapshot (from the run state) is the answer, and seq 0 is its documented cursor.
      await resync('unavailable', (await runs.store.lastSeq(runId).catch(() => null)) ?? 0);
      res.end();
      return;
    }

    const key = RUN_EVENTS_KEY(runId);
    const lastSeq = await runs.store.lastSeq(runId);
    const oldestSeq = await runs.store.oldestSeq(runId);
    const plan = planRunResume({ after: cursor.after, oldestSeq, lastSeq });
    let streamCursor = '0-0';
    let delivered = cursor.after;
    if (plan.kind === 'resync') {
      await resync(plan.reason, lastSeq ?? 0);
      delivered = lastSeq ?? 0;
      if (TERMINAL_STATUSES.has(state.status) || lastSeq === null) {
        res.end();
        return;
      }
      streamCursor = (await runs.store.entryIdForSeq(runId, delivered)) ?? '0-0';
    } else if (plan.after > 0 && oldestSeq !== null && plan.after >= oldestSeq) {
      streamCursor = (await runs.store.entryIdForSeq(runId, plan.after)) ?? '0-0';
    }

    let first = true;
    while (!abort.signal.aborted) {
      const entries = first
        ? await hub.readNow(key, streamCursor)
        : await hub.read(key, streamCursor, { timeoutMs: SSE_HEARTBEAT_INTERVAL_MS, signal: abort.signal });
      first = false;
      if (entries.length === 0) {
        if (abort.signal.aborted) break;
        // Nothing new: a run that ended without a terminal event in its retained stream is closed
        // here (its state is the record); otherwise a ping keeps the connection and the cursor.
        state = await runs.get(tenantId, slug, runId);
        if (TERMINAL_STATUSES.has(state.status) && (await runs.store.lastSeq(runId)) === delivered) {
          res.end();
          return;
        }
        write({ seq: delivered, runId, type: 'ping', ts: new Date().toISOString(), data: {} } as RunEventV2);
        continue;
      }
      for (const entry of entries) {
        streamCursor = entry.id;
        const parsed = parseStoredRunEvent(runId, entry.fields);
        if (parsed.kind !== 'event') continue;
        if (parsed.event.seq <= delivered) continue;
        delivered = parsed.event.seq;
        const outgoing = toPublicRunEvent(parsed.event);
        if (outgoing) write(outgoing);
        if ((TERMINAL_RUN_EVENT_TYPES as readonly string[]).includes(parsed.event.type)) {
          res.end();
          return;
        }
      }
    }
    res.end();
  }

  private requireRuns(): AgentRunService {
    if (!this.agentRuns) {
      throw new ServiceUnavailableException({ code: 'AGENT_RUN_STORE_UNAVAILABLE', message: 'Agent runs are not configured on this gateway.' });
    }
    return this.agentRuns;
  }

  /** The `ner.extract` ledger row for ONE agent invocation — the shared shape, with this route's trigger. */
  private buildNerUsage(tenantId: string, result: AgentNerInvocationResult): ComputeAugmentedBatch | null {
    const batch = withUsageTrigger(
      buildNerUsageEvent({
        tenantId,
        // A fresh id per invocation: keying on anything shared silently drops the second call
        // (see `nerUsageEvent.ts` — that defect is why the key is per-invocation).
        requestId: generateId(),
        charCount: result.charCount,
        model: result.model,
        // TASK-959 §3.2 — what apps/nlp measured for THIS call. Both halves or neither: the
        // builder records no compute row when either is missing, which is why they are carried
        // rather than defaulted here.
        inferenceMs: result.inferenceMs,
        device: result.device,
      }),
      AGENT_INVOCATION_TRIGGER,
    );
    // A NER row can only ever be SELF_HOSTED on the platform's own weights, so it has no
    // tenant-funded half and never a platform leg to split off (`usageLedger/compute-units.ts`).
    return batch ? { batch } : null;
  }

  @Post(':slug/speech')
  // The handler takes `@Res()`, which decides who WRITES the body — not who sets the status
  // line. Nest's `RouterExecutionContext` calls `setStatus(res, httpStatusCode)` before the
  // handler runs either way, so with no `@HttpCode` this route sent the POST default 201 while
  // its own `@ApiResponse` and `openapi.json` published 200. A synthesis is not a created
  // resource; it is the audio, streamed.
  @HttpCode(HttpStatus.OK)
  @Authorize()
  @RequiredScopes('agent:invocation:write')
  @RequiredSvcScopes('svc:agent:invocation:write')
  @Throttle({ heavy: { limit: 20, ttl: 60000 } })
  @ApiOperation({
    summary: 'Synthesize speech with a TEXT_TO_SPEECH agent (streamed audio, the existing speech proxy contract)',
    description:
      'Body `{ text }` or `{ ssml }` (SSML only when the agent enables it). The agent’s voice/format/speed/model are applied over the tenant’s TTS configuration and BYO credentials.',
  })
  @ApiParam({ name: 'slug', type: String })
  // TASK-971 (F-F1) — see the note on `invocations`: `AgentSpeechBody` stays a plain
  // interface, so the shape is documented rather than derived from a DTO.
  @ApiBody({
    required: true,
    description:
      'Provide `text` OR `ssml` — exactly one is expected. Sending neither is a 400; if both are sent, `ssml` is used. ' +
      '`ssml` is accepted only by an agent whose parameters declare `ssml: true`, otherwise it is a 400. ' +
      'Everything else about the synthesis — voice, format, speed, model, engine chain — is the AGENT’s, not the caller’s.',
    schema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'Plain text to synthesise.' },
        ssml: { type: 'string', description: 'An SSML document to synthesise. Only for agents that declare SSML support.' },
        delivery: {
          type: 'string',
          enum: ['stream', 'blob'],
          default: 'stream',
          description:
            '`stream` (default): the audio, streamed. `blob` (TASK-1036): the audio is stored in the tenant’s AUDIO bucket and the answer is JSON ' +
            '`{ mediaId, url, expiresAt, format, sampleRate, durationMs }` — `url` is a short-lived signed GET.',
        },
      },
      example: { text: 'Your appointment is confirmed for Tuesday at ten.' },
    },
  })
  @ApiResponse({
    status: 200,
    description:
      'audio/pcm | audio/wav | audio/mpeg, streamed — or, with `delivery: "blob"`, JSON `{ mediaId, url, expiresAt, format, sampleRate, durationMs }`.',
  })
  @ApiResponse({ status: 503, description: '`TTS_BLOB_STORAGE_UNAVAILABLE` — `delivery: "blob"` and the tenant has no audio bucket.' })
  @ApiResponse({ status: 400, description: 'Missing text/ssml, or the agent is not a TEXT_TO_SPEECH agent.' })
  @ApiResponse({ status: 404, description: 'Unknown, unpublished, or another tenant’s agent.' })
  // TASK-957 F-4 — the tenant's own monthly spend ceiling (D12). Documented on every metered
  // route here because an integrator meets it as an HTTP status long before it meets the
  // billing plane, and 402 is a refusal no retry resolves.
  @ApiResponse({
    status: 402,
    description: 'The tenant has reached the monthly spend limit it set (`monthlySpendLimitMicros`). Refused before anything is spent.',
  })
  async speech(@Param('slug') slug: string, @Body() body: AgentSpeechBody, @Res() res: Response): Promise<void> {
    const delivery = body?.delivery ?? 'stream';
    if (delivery !== 'stream' && delivery !== 'blob') {
      throw new BadRequestException({ message: '`delivery` is `stream` (the default) or `blob`.', code: 'DELIVERY_UNSUPPORTED' });
    }
    const tenantId = this.requireTenant();
    const resolved = await this.resolver.resolve({ tenantId, task: AgentTask.TEXT_TO_SPEECH, agentSlug: slug });
    const { delivery: _delivery, ...speechInput } = body ?? {};
    const agentRequest = this.invocation.buildSpeechRequest(resolved, { ...speechInput });

    // The SAME resolution the speech proxy applies (`tts-tenant-config.ts`), mapped onto the
    // agent's request. Since TASK-879 the agent decides everything — voice, format, speed, model,
    // engine chain — and the tenant's contribution is its connection rows (endpoints, regions,
    // BYO credentials, the three-state `enabled`), which the resolver folds into the same spec.
    const forwardBody: Record<string, unknown> = {
      input: agentRequest.input,
      voice: agentRequest.voice,
      model: agentRequest.model,
      ...(agentRequest.response_format ? { response_format: agentRequest.response_format } : {}),
      ...(agentRequest.speed !== undefined ? { speed: agentRequest.speed } : {}),
    };
    // TASK-958 G3 — the connection the PRIMARY candidate was bound to. Used only as the
    // classification fallback below, for an `apps/tts` that echoes no `X-Tts-Connection-Id`.
    let boundConnectionId: string | null = null;
    if (this.ttsResolver) {
      // FAILS CLOSED: `apps/tts` refuses a request with no resolved spec, so an unresolvable
      // agent must surface as the 404/409 it is rather than as an opaque downstream 503.
      const { spec, providerOverrides } = await this.ttsResolver.resolveFromAgent(resolved, tenantId);
      forwardBody.resolved_spec = spec;
      forwardBody.response_format = forwardBody.response_format ?? spec.primary.parameters.format ?? undefined;
      forwardBody.speed = forwardBody.speed ?? spec.primary.parameters.speed ?? undefined;
      if (providerOverrides && Object.keys(providerOverrides).length > 0) forwardBody.provider_overrides = providerOverrides;
      boundConnectionId = spec.primary.connection?.connectionId ?? null;
    }

    if (this.entitlementsService) {
      await this.entitlementsService.assertMeterQuota(tenantId, 'monthlyTtsCharacters', [...agentRequest.input].length);
    }
    // TASK-957 F-4 — the ceiling, before the synthesis request leaves the gateway.
    await this.billing?.assertSpendLimit(tenantId);

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      // A blob is the whole file, never an event stream.
      Accept: delivery === 'blob' ? 'application/octet-stream' : 'application/octet-stream, text/event-stream',
      ...requestIdHeader(),
    };
    // The ONE shared `INTERNAL_ACCESS_TOKEN` (the `TTS_SERVICE_TOKEN` fallback was retired with its descriptor, TASK-879/880).
    const serviceToken = this.secretsService?.getSecretSync('INTERNAL_ACCESS_TOKEN') || '';
    if (serviceToken) headers['X-Service-Token'] = serviceToken;

    let upstream;
    // TASK-959 §3.2 — the gateway's own clock, started before the request leaves. It is the
    // fallback occupancy figure for the STREAMED modes, where `apps/tts` cannot know a total at
    // header time and says so by omitting the header rather than sending a wrong one.
    const startedAtMs = Date.now();
    try {
      upstream = await this.httpService.axiosRef.post(`${this.configService.getConfigValue('TTS_URL')}/api/v1/audio/speech`, forwardBody, {
        headers,
        responseType: 'stream',
        timeout: 300_000,
      });
    } catch (err) {
      const axiosError = err as AxiosError;
      const status = axiosError.response?.status;
      // Never forward the upstream body — a synthesis error can echo the input (PHI).
      this.logger.error({ message: 'Agent speech upstream error (body redacted)', agentSlug: slug, upstreamStatus: status });
      if (typeof status === 'number') throw new HttpException({ detail: 'Speech synthesis failed' }, status);
      const kind = classifyDownstreamFailure(err);
      throw new HttpException({ detail: 'Speech synthesis failed' }, kind ? downstreamStatusFor(kind) : HttpStatus.BAD_GATEWAY);
    }

    const contentType = (upstream.headers['content-type'] as string | undefined) ?? 'application/octet-stream';

    const provider = (upstream.headers['x-tts-provider'] as string | undefined) || undefined;
    // TASK-958 D-7 — which of the tenant's accounts of that vendor was spent. An
    // agent may bind a NON-default connection, so the provider name no longer says it.
    const connectionId = (upstream.headers['x-tts-connection-id'] as string | undefined) || null;
    const overridesForClassification = forwardBody.provider_overrides as Parameters<typeof classifyTtsProvider>[1] | undefined;
    // TASK-958 G3 (W1d) — the FOURTH `classifyTtsProvider` call site, and the one that was
    // still calling it with two arguments while reading the header two lines above. The map is
    // keyed by CONNECTION KEY, so without the served id the classifier falls back to
    // `servingEntry`'s heuristics — the exact provider key, else exactly ONE `provider:`
    // prefixed entry. A tenant with TWO accounts of one vendor in the chain is ambiguous by
    // construction there, so its own BYOK synthesis was labelled platform `CLOUD` and charged
    // to COGS.
    //
    // The spec's primary connection is the fallback for an `apps/tts` that echoes no header.
    // It is deliberately NOT stamped on the ledger row below: the echo names the candidate
    // that actually served, the spec names the one we asked for, and selecting an entry out of
    // a map this request itself sent is a weaker claim than naming the row that was spent.
    const classifyConnectionId = connectionId ?? boundConnectionId;
    const { deployment, costBasis } = provider
      ? classifyTtsProvider(provider, overridesForClassification, classifyConnectionId)
      : { deployment: undefined, costBasis: undefined };
    const requestId = generateId();
    const characters = [...agentRequest.input].length;
    // TASK-959 §3.2 — what `apps/tts` reported about THIS synthesis. Every reader refuses to
    // guess: an absent device records no compute row at all (a cloud vendor's hardware is not
    // ours to bill as platform compute), and an absent byte count falls back to what this
    // gateway itself relayed, declared as an app-level count rather than a wire one.
    const synthesisMs = positiveNumber(upstream.headers['x-tts-synthesis-ms']);
    const device = computeDeviceHeader(upstream.headers['x-tts-device']);
    const reportedBytes = positiveNumber(upstream.headers['x-tts-response-bytes']);
    const reportedByteSource = byteSourceHeader(upstream.headers['x-tts-byte-source']);
    let relayedBytes = 0;
    let emitted = false;
    const emitUsage = (interrupted: boolean): void => {
      if (emitted || !this.usageLedger) return;
      emitted = true;
      // TASK-957 F-10 — no provider, no row. `apps/tts` sends `'none'` when it cannot name the
      // engine that served, and an absent header says the same thing. Writing the row anyway
      // asserted `provider: 'none'` (in no price book — zero COGS) on `SELF_HOSTED` (the
      // platform's own hardware, the one claim a missing header contradicts), while still
      // draining the tenant's CHARACTER allowance ahead of rows that CAN be rated.
      if (!isAttributableTtsProvider(provider)) {
        recordUsageEmissionFailure('tts.synthesize', 'unattributable');
        this.logger.warn({
          message: 'TTS synthesis reported no provider; recording no usage row for it',
          agentSlug: slug,
          requestId,
        });
        return;
      }
      const responseBytes = reportedBytes ?? (relayedBytes > 0 ? relayedBytes : null);
      const batch: UsageEventBatchInput = {
        common: {
          tenantId,
          idempotencyKey: UsageIdempotencyKey.ttsRequest(requestId),
          occurredAt: new Date(),
          capability: AiCapability.TTS,
          operation: 'tts.synthesize', // the frozen TTS operation; the agent identity rides on attributesJson
          provider,
          model: resolved.compiledConfig.model.slug,
          deployment: deployment ?? AiDeploymentKind.SELF_HOSTED,
          ...(costBasis ? { costBasis } : {}),
          connectionId,
          requestId,
          // Allow-listed dimensions only (usage-attributes.ts); the agent identity is
          // on the response headers. `trigger` names the ACTIVITY (TASK-890 OD-E).
          attributesJson: { interrupted, trigger: AGENT_INVOCATION_TRIGGER },
        },
        units: [{ unit: AiUsageUnit.CHARACTER, quantity: characters }],
      };
      // The service's own measurement first; the relay's own wall clock only when it reported
      // none, which is exactly the streamed modes (`X-Tts-Synthesis-Ms` is batch-only, because a
      // stream's total is unknown at header time).
      const occupancyMs = synthesisMs ?? Date.now() - startedAtMs;
      // TASK-959 §3.2/§4.2 — the ONE shared appender, on the batch this closure just built.
      const { batch: primary, platformBatch } = appendComputeAndByteUnits(batch, {
        device,
        totalMs: occupancyMs,
        responseBytes,
        // The service says how it counted when it counted; our own relay count is an
        // application-level proxy for the audio produced, and says so.
        byteSource: responseBytes === null ? null : (reportedByteSource ?? (reportedBytes === null ? 'app' : null)),
      });
      for (const input of platformBatch ? [primary, platformBatch] : [primary]) {
        this.usageLedger
          .recordUsage(input)
          .catch((err: unknown) =>
            this.logger.warn({ message: 'Agent speech usage emission failed', error: err instanceof Error ? err.message : String(err) }),
          );
      }
    };

    const stream = upstream.data;

    if (delivery === 'blob') {
      // TASK-1036 §3.2 — buffer the whole synthesis, store it in the tenant bucket, answer JSON.
      const chunks: Buffer[] = [];
      try {
        await new Promise<void>((resolve, reject) => {
          stream.on('data', (chunk: Buffer) => {
            relayedBytes += chunk.length;
            chunks.push(chunk);
          });
          stream.on('end', () => resolve());
          stream.on('error', (err: Error) => reject(err));
        });
      } catch (err) {
        this.logger.error({ message: 'Agent speech stream error', agentSlug: slug, error: err instanceof Error ? err.message : String(err) });
        emitUsage(true);
        throw new HttpException({ detail: 'Speech synthesis failed' }, HttpStatus.BAD_GATEWAY);
      }
      emitUsage(false);
      if (!this.tenantBuckets || !this.blobStorage || !this.mediaService) {
        throw new ServiceUnavailableException({ code: 'TTS_BLOB_STORAGE_UNAVAILABLE', message: 'Blob delivery is not configured on this gateway.' });
      }
      const reportedSeconds = positiveNumber(upstream.headers['x-tts-audio-seconds']);
      const answer = await persistSpeechBlob(
        { blobStorage: this.blobStorage, tenantBuckets: this.tenantBuckets, media: this.mediaService, settings: this.tenantSettings },
        {
          tenantId,
          agentSlug: resolved.slug,
          audio: Buffer.concat(chunks),
          format: speechBlobFormat(upstream.headers['x-tts-audio-format'], forwardBody.response_format, contentType),
          sampleRate: positiveNumber(upstream.headers['x-tts-sample-rate']),
          durationMs: reportedSeconds === null ? null : Math.round(reportedSeconds * 1000),
        },
      );
      res.setHeader('X-Agent-Slug', resolved.slug);
      res.setHeader('X-Agent-Version-Id', resolved.agentVersionId);
      res.status(HttpStatus.OK).json(answer);
      return;
    }

    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'no-store, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('X-Agent-Slug', resolved.slug);
    res.setHeader('X-Agent-Version-Id', resolved.agentVersionId);
    res.flushHeaders();
    stream.on('data', (chunk: Buffer) => {
      relayedBytes += chunk.length;
      res.write(chunk);
    });
    stream.on('end', () => {
      res.end();
      emitUsage(false);
    });
    stream.on('error', (err: Error) => {
      this.logger.error({ message: 'Agent speech stream error', agentSlug: slug, error: err.message });
      res.end();
      emitUsage(true);
    });
    res.on('close', () => {
      stream.destroy();
      emitUsage(true);
    });
  }

  @Post(':slug/transcriptions')
  @HttpCode(HttpStatus.CREATED)
  @Authorize()
  @RequiredScopes('agent:invocation:write')
  @RequiredSvcScopes('svc:agent:invocation:write')
  @ApiOperation({
    summary: 'Start a batch transcription with a SPEECH_TO_TEXT agent (returns a TranscriptionJob)',
    description:
      'Body `{ mediaId, consultationId?, language?, languageMode? }` — the media must already be uploaded. The spoken-language mode is the ' +
      "request's (`languageMode` > `language`), else the consultation's declared one, else the agent's own; it never chooses the engine. " +
      'The agent is resolved to a `ResolvedAsrSpec` ' +
      '(TASK-861) the job is keyed to and reproducible from; no pipeline row is involved. Progress streams from the returned `sseUrl`.',
  })
  @ApiParam({ name: 'slug', type: String })
  // TASK-1004 — the body is a real DTO now (`AgentTranscriptionRequest`): unlike `invocations`,
  // its shape is the gateway's, not the agent's `inputSchema`, so an undeclared field is refused.
  @ApiBody({
    required: true,
    type: AgentTranscriptionRequest,
    description:
      'Batch transcription of media ALREADY uploaded through the media plane — this route takes an id, never audio bytes. ' +
      'The answer is a 201 carrying the job and an `sseUrl` to watch it on; the transcript is not in the response.',
  })
  @ApiResponse({ status: 201, description: 'The transcription job.' })
  @ApiResponse({
    status: 400,
    description:
      'Missing mediaId, the agent is not a SPEECH_TO_TEXT agent, or `LANGUAGE_MODE_UNKNOWN` — `languageMode` / `language` names no spoken-language mode.',
  })
  @ApiResponse({ status: 404, description: 'Unknown, unpublished, or another tenant’s agent (or media).' })
  @ApiResponse({ status: 409, description: 'The agent cannot become a runnable ASR spec (no primary model), or a provider veto.' })
  // TASK-957 F-4 — the tenant's own monthly spend ceiling (D12). Documented on every metered
  // route here because an integrator meets it as an HTTP status long before it meets the
  // billing plane, and 402 is a refusal no retry resolves.
  @ApiResponse({
    status: 402,
    description: 'The tenant has reached the monthly spend limit it set (`monthlySpendLimitMicros`). Refused before anything is spent.',
  })
  async transcribe(@Param('slug') slug: string, @Body() body: AgentTranscriptionRequest): Promise<AgentTranscriptionResponse> {
    const tenantId = this.requireTenant();
    if (!body?.mediaId) throw new BadRequestException('`mediaId` is required.');
    // TASK-1004 — the explicit mode, normalized; 400 LANGUAGE_MODE_UNKNOWN before any I/O.
    const requestedMode = requestedLanguageMode(body);
    // TASK-957 F-4 — the ceiling, before a job row exists or a worker is dispatched. This route
    // carries no meter quota of its own (batch minutes are metered on COMPLETION, when the audio
    // length is known), so the ceiling is the only pre-flight money gate it has.
    await this.billing?.assertSpendLimit(tenantId);
    if (!this.jobService || !this.realtimeService || !this.mediaService || !this.asrResolver) {
      throw new HttpException({ detail: 'Batch transcription is not configured on this gateway' }, HttpStatus.SERVICE_UNAVAILABLE);
    }
    // TASK-861 — one resolution: explicit slug → PUBLISHED ACTIVE SPEECH_TO_TEXT agent
    // (404-over-403 inside) → ResolvedAsrSpec. Credentials never enter the job row or
    // the queue message; the worker pulls them at execution time.
    //
    // TASK-1004 — a request that declares no language inherits the consultation's: the resolver
    // reads it ONCE (tenant-scoped, 404 on a foreign id) and never lets it touch the agent choice.
    const inherit = Boolean(body.consultationId && !requestedMode);
    const resolved = await this.asrResolver.resolve({
      tenantId,
      agentSlug: slug,
      departmentId: null,
      ...(inherit ? { consultationId: body.consultationId, inheritConsultationLanguage: true } : {}),
    });
    const { spec } = resolved;
    const effective = resolveEffectiveLanguageMode({ request: requestedMode, consultation: resolved.consultationLanguageMode ?? null });
    const language =
      effective.source === 'request' || effective.source === 'consultation'
        ? { languageMode: effective.mode, languageModeSource: effective.source }
        : {};
    const media = await this.mediaService.fetchById(body.mediaId);
    const job = await this.jobService.createBatchJob({
      agentVersionId: spec.agent.versionId,
      resolvedSpec: spec as unknown as Record<string, unknown>,
      mediaId: body.mediaId,
      consultationId: body.consultationId,
    });
    try {
      await this.realtimeService.dispatchDramatiqJob({
        jobId: job.id,
        tenantId,
        resolvedSpec: spec,
        audioUri: media.uri,
        consultationId: body.consultationId,
        mediaId: body.mediaId,
        language: body.language,
        userId: this.cls.get('user')?.id,
        // TASK-1004 — request > consultation, as the named kwargs; absent → STT applies the agent's own.
        ...language,
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error({ message: 'Agent batch transcription dispatch failed', jobId: job.id, error: message });
      await this.jobService.failJob(job.id, message, 'SETUP_ERROR').catch(() => undefined);
      throw error instanceof HttpException ? error : new HttpException({ detail: 'Batch transcription dispatch failed' }, HttpStatus.BAD_GATEWAY);
    }
    return {
      id: job.id,
      status: String(job.status),
      agentSlug: spec.agent.slug,
      agentVersionId: spec.agent.versionId,
      sseUrl: `/api/v1/audio/transcription-jobs/${job.id}/stream`,
    };
  }

  /**
   * The blocking invocation's GENERATION batch (TASK-957 F-2).
   *
   * TEXT's `usage_detail` block is the source whenever it sent one: it carries the task id the
   * idempotency key must derive from (the only join between a ledger row and TEXT's persisted
   * task log, which is what a disputed invoice is reconciled from), the cache-read/write and
   * reasoning split, the endpoint kind and service tier the rater selects price rows by, TEXT's
   * own clock, and the connection id. This route's STREAM path has always billed that way; the
   * blocking path billed two counts and a random id, which under-billed every cloud model that
   * reports a cache or a reasoning split.
   *
   * The counts-only builder below remains the fallback for exactly one case — TEXT sent no block
   * at all (an older service, or a response that carried nothing). Fabricating an `endpointKind`
   * to reach the richer builder would stamp an API shape that never happened.
   */
  private async buildBlockingUsage(
    tenantId: string,
    resolved: ResolvedAgent,
    result: AgentTextInvocationResult,
  ): Promise<ComputeAugmentedBatch | null> {
    const detail = parseTextUsageDetail(result.usageDetail);
    if (detail) {
      // FUNDING IS DERIVED, NEVER STAMPED (rule 09): the builder reads `byok` off TEXT's own
      // block — the service that actually authenticated — rather than from the agent's resolved
      // funding tier, so a fallback that changed which credential served the call cannot be
      // mis-attributed here.
      //
      // TASK-959 — the `*Batches` sibling, not `buildLlmUsageInput`: THE BUILDER APPENDS the
      // compute and byte rows (one append per batch, `usageLedger/compute-units.ts`), and only
      // this form hands back the platform CPU leg of a BYOK call. The `device` it needs is
      // resolved HERE because the builder is a pure module and the cascade is asynchronous.
      const provider = toLedgerProvider(detail.textProvider);
      return this.stamp(
        buildLlmUsageBatches({
          usage: detail,
          tenantId,
          operation: 'generate',
          doctorId: result.actingUserId ?? null,
          device: await this.llmDevice(tenantId, provider, resolveDeployment(provider, detail.byok)),
        }),
        { trigger: AGENT_INVOCATION_TRIGGER },
      );
    }
    return this.buildBlockingUsageFromCounts(tenantId, resolved, result);
  }

  /**
   * The pre-F-2 path, kept for a TEXT that reported no `usage_detail`.
   *
   * FUNDING IS DERIVED, NEVER STAMPED (rule 09): `fundingTier === 'tenant'`
   * means the tenant's own credential served the call, which is BYOK whichever
   * vendor answered; only an unfunded call lets the provider decide
   * self-hosted vs cloud.
   */
  private buildBlockingUsageFromCounts(tenantId: string, resolved: ResolvedAgent, result: AgentTextInvocationResult): ComputeAugmentedBatch | null {
    if (!result.usage) return null;
    const byok = resolved.fundingTier === 'tenant';
    const provider = toLedgerProvider(result.provider ?? resolved.compiledConfig.model.provider ?? '');
    const pair = buildLlmUsageBatchesFromTokenCounts({
      tenantId,
      operation: 'generate',
      // No TEXT task id on the blocking path, so a fresh intent id per request:
      // this emission happens exactly once and has no abort path to converge with.
      requestId: generateId(),
      provider: provider || 'none',
      model: result.model ?? resolved.compiledConfig.model.slug,
      deployment: AiDeploymentKind[classifyLlmDeployment(provider, byok)],
      occurredAt: new Date(),
      inputTokens: result.usage.promptTokens,
      outputTokens: result.usage.completionTokens,
      // TASK-950 (decision 3, fast win) — the clinician this call acted FOR, resolved from the
      // agent's frozen context schema for a machine caller and handed back on the result. Same
      // column, same meaning as on the stream path above and on a consultation-driven call;
      // `null` for a human or API-key caller, exactly as today.
      doctorId: result.actingUserId ?? null,
      // `costBasis` is never derived from `deployment` (usage-event.input.ts): a BYOK emitter
      // states it, or the row defaults to INTERNAL and over-reports platform spend — the safe
      // direction, but wrong for a tenant-funded call. Passed INTO the builder rather than
      // stamped onto its result, because the basis is what decides whether a compute row splits
      // onto a second batch (§6.3) — a basis applied afterwards would be applied too late.
      ...(byok ? { costBasis: AiCostBasis.BYOK_NOTIONAL } : {}),
    });
    return this.stamp(pair, { trigger: AGENT_INVOCATION_TRIGGER });
  }

  /**
   * One teardown of a streaming invocation: everything the shared collector metered off the
   * terminal frame — tokens, compute, bytes, and the guard call TEXT made for this stream.
   *
   * PEEK, RESOLVE, THEN TAKE. The device decides the compute UNIT and is resolved from
   * configuration keyed by the provider that ACTUALLY served, which is only known once the
   * terminal frame is parsed — and the resolution is asynchronous, while the batch is built
   * synchronously inside `takeAll`. So the provider is read first, without consuming anything.
   *
   * `takeAll()` answers once, so the three teardown handlers (`end`, `error`, the client's
   * `close`) still produce exactly one emission however many of them fire — including across the
   * `await` below, where two of them may legitimately be in flight at the same time.
   */
  private async emitStreamInvocationUsage(
    collector: LlmStreamUsageCollector,
    params: { tenantId: string; doctorId: string | null; interrupted?: boolean },
    agentSlug: string,
    guardrail: GuardrailDisposition,
  ): Promise<void> {
    const attribution = collector.peekGenerationAttribution();
    const device = attribution ? await this.llmDevice(params.tenantId, attribution.provider, attribution.deployment) : null;
    const batches = collector.takeAll({
      tenantId: params.tenantId,
      operation: 'generate.stream',
      trigger: AGENT_INVOCATION_TRIGGER,
      doctorId: params.doctorId,
      device,
      ...(params.interrupted ? { interrupted: true } : {}),
    });
    if (!batches) return;
    this.emitInvocationUsage(batches.generation, agentSlug, guardrail);
    // TASK-957 F-3 on the STREAM, for the same reason as the blocking path: the screening call is
    // another provider call with its own operation and key, and it carries NO `guardrail`
    // disposition — stamping how a generation was screened onto the screening itself is circular.
    this.emitInvocationUsage(batches.guardrail, agentSlug);
  }

  /**
   * The `guardrail.validate` batch for the screening call TEXT made ON THIS REQUEST'S BEHALF
   * (TASK-957 F-3).
   *
   * Metered in full for COGS, never quota-blocked and never line-itemed to a tenant (D16) — a
   * safety check the platform mandates belongs in per-encounter margin, not on a bill. Until this
   * lane it was recorded on the consultation summary paths ONLY, so every agent-plane guardrail
   * call was invisible to the `GUARDRAIL_CALLS` meter and to guardrail COGS.
   *
   * `fallbackRequestId` is the GENERATION's task id: guardrail usually reports its own, and when
   * it does not, tying the row to the request it screened beats a random key.
   */
  private async buildBlockingGuardrailUsage(tenantId: string, result: AgentTextInvocationResult): Promise<ComputeAugmentedBatch | null> {
    const detail = parseTextUsageDetail(result.guardrailUsage);
    if (!detail) return null;
    // The guard call is its OWN provider call: its device is resolved from ITS provider, not the
    // generation's, because a tenant may screen on one engine and generate on another.
    const provider = toLedgerProvider(detail.textProvider);
    return this.stamp(
      buildGuardrailUsageBatches({
        usage: detail,
        tenantId,
        doctorId: result.actingUserId ?? null,
        fallbackRequestId: parseTextUsageDetail(result.usageDetail)?.taskId ?? null,
        device: await this.llmDevice(tenantId, provider, resolveDeployment(provider, detail.byok)),
      }),
      { trigger: AGENT_INVOCATION_TRIGGER },
    );
  }

  /**
   * Fire-and-forget emission. The generation already happened and the caller
   * already has its bytes: a metering failure must degrade to "not metered",
   * never to a broken response.
   *
   * TASK-959 — `sample` carries what the serving side reported about COMPUTE and NETWORK for this
   * same call. The append can split one batch into two (a BYOK call's CPU seconds are the
   * platform's money while its tokens are the tenant's), which is why this emits a LIST.
   */
  private emitInvocationUsage(pair: ComputeAugmentedBatch | null, agentSlug: string, guardrail?: GuardrailDisposition): void {
    if (!pair || !this.usageLedger) return;
    // `guardrail` is stamped on GENERATION rows only. The speech path passes none, and that is
    // the honest answer rather than an omission: a TTS call never reaches the guardrail gate, so
    // the dimension does not apply — which the allow-list models as an absent key, never as a
    // fabricated `screened`.
    const stamped = guardrail ? (this.stamp(pair, { guardrail }) ?? pair) : pair;
    for (const input of stamped.platformBatch ? [stamped.batch, stamped.platformBatch] : [stamped.batch]) {
      void this.usageLedger.recordUsage(input).catch((err: unknown) =>
        this.logger.warn({
          message: 'Agent invocation usage emission failed',
          agentSlug,
          error: err instanceof Error ? err.message : String(err),
        }),
      );
    }
  }

  /**
   * Stamp allow-listed dimensions on BOTH halves of an augmented pair.
   *
   * The platform CPU leg of a BYOK call is the same product activity, screened the same way, as
   * the tokens beside it — a dimension that answers "why did this cost happen" has one answer per
   * request, not one per cost basis.
   */
  private stamp(pair: ComputeAugmentedBatch | null, attributes: UsageAttributes): ComputeAugmentedBatch | null {
    if (!pair) return null;
    const batch = withUsageAttributes(pair.batch, attributes);
    if (!batch) return null;
    const platformBatch = pair.platformBatch ? (withUsageAttributes(pair.platformBatch, attributes) ?? undefined) : undefined;
    return platformBatch ? { batch, platformBatch } : { batch };
  }

  /**
   * Which device an LLM call's seconds were spent on — `null` when this gateway has no business
   * naming one.
   *
   * A CLOUD or BYOK call is NOT the vendor's hardware: those seconds are the platform's own CPU
   * spent CALLING the vendor (the owner's M-3), which the appender meters as `cpu` whatever is
   * passed, so nothing is resolved for them and the cascade is not read at all. Only a
   * self-hosted server has a device worth looking up, and `apps/text` cannot report it — it is
   * stateless per call and neither `GenerateRequest` nor `AiModel` carries one (`computeType` is
   * a precision, not a device).
   *
   * `null` also when the resolver is not wired (a minimal fixture) or when it raises despite its
   * contract not to (an unresolvable cascade answers `cpu`): no compute row, never a guessed one,
   * and never a lost usage batch or a broken response. This runs on the REQUEST path of the
   * blocking route, so a throw here would cost the caller its answer over an accounting detail.
   */
  private async llmDevice(tenantId: string, provider: string, deployment: AiDeploymentKind): Promise<ComputeDevice | null> {
    if (deployment !== AiDeploymentKind.SELF_HOSTED) return null;
    try {
      return (await this.computeDevice?.resolve(tenantId, provider)) ?? null;
    } catch (err: unknown) {
      this.logger.warn({
        message: 'Compute device unresolved; metering this call without a compute row',
        provider,
        error: err instanceof Error ? err.message : String(err),
      });
      return null;
    }
  }

  private requireTenant(): string {
    const tenantId = this.cls.get('tenantId');
    if (!tenantId) throw new BadRequestException('Tenant context required');
    return tenantId;
  }
}
