import {
  AgentInvocationService,
  AgentResolverService,
  AsrAgentResolverService,
  AgentSummaryListResponse,
  AgentSummaryResponse,
  AgentTask,
  Authorize,
  IActiveUserContext,
  IAgentService,
  IConfigService,
  IEntitlementsService,
  IMediaService,
  IUsageLedgerService,
  LlmStreamUsageCollector,
  SecretsService,
  TranscriptionJobService,
  TranscriptionRealtimeService,
  TtsAgentResolverService,
  UsageIdempotencyKey,
  buildLlmUsageInputFromTokenCounts,
  buildNerUsageEvent,
  classifyLlmDeployment,
  toLedgerProvider,
  withUsageAttributes,
  withUsageTrigger,
} from '@arcaai/applications';
import type {
  AgentNerEntity,
  AgentNerInvocationResult,
  AgentTextInvocationResult,
  GuardrailDisposition,
  ResolvedAgent,
  UsageEventBatchInput,
} from '@arcaai/applications';
import { AiCapability, AiCostBasis, AiDeploymentKind, AiUsageUnit, generateId } from '@arcaai/domains';
import { HttpService } from '@nestjs/axios';
import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  HttpStatus,
  Inject,
  Logger,
  Optional,
  Param,
  Post,
  Query,
  Res,
} from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiParam, ApiQuery, ApiResponse, ApiTags } from '@nestjs/swagger';
import { Throttle } from '@nestjs/throttler';
import type { AxiosError } from 'axios';
import type { Response } from 'express';
import { ClsService } from 'nestjs-cls';
import { RequiredScopes, RequiredSvcScopes } from '../../decorators';
import { classifyDownstreamFailure, downstreamStatusFor } from '../../filters/downstream-error';
import { classifyTtsProvider } from '../speech/tts-provider-classification';

/** Plain interfaces (not class-validator DTOs) so the global pipe passes the body through; TIER 3 validation runs against the agent's own `inputSchema`. */
export interface AgentInvocationBody {
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
}
export interface AgentTranscriptionBody {
  mediaId: string;
  consultationId?: string;
  language?: string;
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
  /** @deprecated TASK-861 — removed in R4. Now the spec's runtime key (= `agentVersionId`); read `agentVersionId`. */
  pipelineId: string;
  sseUrl: string;
}

const SSE_HEARTBEAT_INTERVAL_MS = 15_000;

/**
 * Every ledger row this controller writes names the activity that produced it
 * (TASK-890 OD-E). All three routes here ARE the agent business plane, so the
 * value is a constant rather than a parameter — a caller cannot claim to be
 * something else.
 */
const AGENT_INVOCATION_TRIGGER = 'AGENT_INVOCATION' as const;

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
  @ApiOperation({ summary: 'Describe one published agent: its task, version, I/O schemas and protocols' })
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
      'The body is validated against the agent’s `inputSchema` (default: `{ text, variables? }`). `mode=blocking` answers `200 application/json`; ' +
      '`mode=stream` answers `200 text/event-stream` with the TEXT service’s frames relayed verbatim.',
  })
  @ApiParam({ name: 'slug', type: String })
  @ApiQuery({ name: 'mode', required: false, enum: ['blocking', 'stream'] })
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
    description: 'The identity resolver is not configured, so a request that names a clinician cannot be honoured (`USER_IDENTITY_RESOLVER_UNAVAILABLE`).',
  })
  @ApiResponse({
    status: 429,
    description: 'The tenant has reached its `monthlyLlmTokens` allowance. Refused before the model runs, so nothing is billed.',
  })
  async invoke(@Param('slug') slug: string, @Body() body: AgentInvocationBody, @Res() res: Response, @Query('mode') mode?: string): Promise<void> {
    const tenantId = this.requireTenant();
    // TASK-930 §2.4 — resolved WITHOUT a task pin, then dispatched on the agent's own task.
    // Pinning TEXT_GENERATION here would have made a NER agent unreachable through the route
    // its `protocols: ['http']` declares, and the refusal would have named the wrong thing
    // ("this call needs TEXT_GENERATION") for a caller who asked for exactly what it published.
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

    // TASK-890 §3.14 (OD-R) — how this call was screened, resolved ONCE here and stamped on
    // whichever row the call ends up producing (the stream path emits from three handlers).
    // Read before the generation rather than after it so an abort still records the disposition
    // that was in force when the tokens were spent.
    const guardrail = await this.invocation.guardrailDisposition(resolved.guardrail);

    if (mode === 'stream') {
      const { stream } = await this.invocation.invokeText(resolved, tenantId, body ?? {}, 'stream');
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
        this.emitInvocationUsage(collector.take({ tenantId, operation: 'generate.stream', trigger: AGENT_INVOCATION_TRIGGER }), slug, guardrail);
      });
      stream.on('error', (err: Error) => {
        clearInterval(heartbeat);
        this.logger.error({ message: 'Agent invocation stream error', agentSlug: slug, error: err.message });
        res.end();
        // The tokens seen before the socket died were still spent.
        this.emitInvocationUsage(
          collector.take({ tenantId, operation: 'generate.stream', trigger: AGENT_INVOCATION_TRIGGER, interrupted: true }),
          slug,
          guardrail,
        );
      });
      res.on('close', () => {
        clearInterval(heartbeat);
        stream.destroy();
        this.emitInvocationUsage(
          collector.take({ tenantId, operation: 'generate.stream', trigger: AGENT_INVOCATION_TRIGGER, interrupted: true }),
          slug,
          guardrail,
        );
      });
      return;
    }

    const result = await this.invocation.invokeText(resolved, tenantId, body ?? {}, 'blocking');
    this.emitInvocationUsage(this.buildBlockingUsage(tenantId, resolved, result), slug, guardrail);
    const payload: AgentTextInvocationResponse = {
      agentSlug: resolved.slug,
      agentVersionId: resolved.agentVersionId,
      output: { text: result.text },
      provider: result.provider,
      model: result.model,
      usage: result.usage,
      promptFragments: result.promptFragments ?? null,
    };
    res.status(HttpStatus.OK).json(payload);
  }

  /**
   * TASK-930 §2.4 — the NER half of `POST /agents/:slug/invocations`.
   *
   * One-shot by construction: `apps/nlp` classifies the whole document in a single pass, so
   * `?mode=stream` is REFUSED with a named code rather than degraded to a blocking answer — a
   * caller that opened an SSE reader against a silent one-shot route would simply hang, and a
   * 400 that says why is the only honest reply to a protocol the agent never declared.
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
    const { context: _context, ...invocationInput } = body ?? {};
    const problems = this.invocation.inputProblems(resolved, invocationInput);
    if (problems.length > 0) throw new BadRequestException({ message: 'The invocation body does not match the agent’s inputSchema.', problems });

    await this.entitlementsService?.assertMeterQuota(tenantId, 'monthlyNlpTextUnits');
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
    res.status(HttpStatus.OK).json(payload);
  }

  /** The `ner.extract` ledger row for ONE agent invocation — the shared shape, with this route's trigger. */
  private buildNerUsage(tenantId: string, result: AgentNerInvocationResult): UsageEventBatchInput {
    return withUsageTrigger(
      buildNerUsageEvent({
        tenantId,
        // A fresh id per invocation: keying on anything shared silently drops the second call
        // (see `nerUsageEvent.ts` — that defect is why the key is per-invocation).
        requestId: generateId(),
        charCount: result.charCount,
        model: result.model,
      }),
      AGENT_INVOCATION_TRIGGER,
    );
  }

  @Post(':slug/speech')
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
  @ApiResponse({ status: 200, description: 'audio/pcm | audio/wav | audio/mpeg, streamed.' })
  @ApiResponse({ status: 400, description: 'Missing text/ssml, or the agent is not a TEXT_TO_SPEECH agent.' })
  @ApiResponse({ status: 404, description: 'Unknown, unpublished, or another tenant’s agent.' })
  async speech(@Param('slug') slug: string, @Body() body: AgentSpeechBody, @Res() res: Response): Promise<void> {
    const tenantId = this.requireTenant();
    const resolved = await this.resolver.resolve({ tenantId, task: AgentTask.TEXT_TO_SPEECH, agentSlug: slug });
    const agentRequest = this.invocation.buildSpeechRequest(resolved, { ...(body ?? {}) });

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
    if (this.ttsResolver) {
      // FAILS CLOSED: `apps/tts` refuses a request with no resolved spec, so an unresolvable
      // agent must surface as the 404/409 it is rather than as an opaque downstream 503.
      const { spec, providerOverrides } = await this.ttsResolver.resolveFromAgent(resolved, tenantId);
      forwardBody.resolved_spec = spec;
      forwardBody.response_format = forwardBody.response_format ?? spec.primary.parameters.format ?? undefined;
      forwardBody.speed = forwardBody.speed ?? spec.primary.parameters.speed ?? undefined;
      if (providerOverrides && Object.keys(providerOverrides).length > 0) forwardBody.provider_overrides = providerOverrides;
    }

    if (this.entitlementsService) {
      await this.entitlementsService.assertMeterQuota(tenantId, 'monthlyTtsCharacters', [...agentRequest.input].length);
    }

    const headers: Record<string, string> = { 'Content-Type': 'application/json', Accept: 'application/octet-stream, text/event-stream' };
    // The ONE shared `INTERNAL_ACCESS_TOKEN` (the `TTS_SERVICE_TOKEN` fallback was retired with its descriptor, TASK-879/880).
    const serviceToken = this.secretsService?.getSecretSync('INTERNAL_ACCESS_TOKEN') || '';
    if (serviceToken) headers['X-Service-Token'] = serviceToken;

    let upstream;
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
    res.setHeader('Content-Type', contentType);
    res.setHeader('Cache-Control', 'no-store, no-transform');
    res.setHeader('X-Accel-Buffering', 'no');
    res.setHeader('X-Agent-Slug', resolved.slug);
    res.setHeader('X-Agent-Version-Id', resolved.agentVersionId);
    res.flushHeaders();

    const provider = (upstream.headers['x-tts-provider'] as string | undefined) || undefined;
    const overridesForClassification = forwardBody.provider_overrides as Parameters<typeof classifyTtsProvider>[1] | undefined;
    const { deployment, costBasis } = provider
      ? classifyTtsProvider(provider, overridesForClassification)
      : { deployment: undefined, costBasis: undefined };
    const requestId = generateId();
    const characters = [...agentRequest.input].length;
    let emitted = false;
    const emitUsage = (interrupted: boolean): void => {
      if (emitted || !this.usageLedger) return;
      emitted = true;
      this.usageLedger
        .recordUsage({
          common: {
            tenantId,
            idempotencyKey: UsageIdempotencyKey.ttsRequest(requestId),
            occurredAt: new Date(),
            capability: AiCapability.TTS,
            operation: 'tts.synthesize', // the frozen TTS operation; the agent identity rides on attributesJson
            provider: provider ?? 'none',
            model: resolved.compiledConfig.model.slug,
            deployment: deployment ?? AiDeploymentKind.SELF_HOSTED,
            ...(costBasis ? { costBasis } : {}),
            requestId,
            // Allow-listed dimensions only (usage-attributes.ts); the agent identity is
            // on the response headers. `trigger` names the ACTIVITY (TASK-890 OD-E).
            attributesJson: { interrupted, trigger: AGENT_INVOCATION_TRIGGER },
          },
          units: [{ unit: AiUsageUnit.CHARACTER, quantity: characters }],
        })
        .catch((err: unknown) =>
          this.logger.warn({ message: 'Agent speech usage emission failed', error: err instanceof Error ? err.message : String(err) }),
        );
    };

    const stream = upstream.data;
    stream.on('data', (chunk: Buffer) => res.write(chunk));
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
      'Body `{ mediaId, consultationId?, language? }` — the media must already be uploaded. The agent is resolved to a `ResolvedAsrSpec` ' +
      '(TASK-861) the job is keyed to and reproducible from; no pipeline row is involved. Progress streams from the returned `sseUrl`.',
  })
  @ApiParam({ name: 'slug', type: String })
  @ApiResponse({ status: 201, description: 'The transcription job.' })
  @ApiResponse({ status: 400, description: 'Missing mediaId, or the agent is not a SPEECH_TO_TEXT agent.' })
  @ApiResponse({ status: 404, description: 'Unknown, unpublished, or another tenant’s agent (or media).' })
  @ApiResponse({ status: 409, description: 'The agent cannot become a runnable ASR spec (no primary model), or a provider veto.' })
  async transcribe(@Param('slug') slug: string, @Body() body: AgentTranscriptionBody): Promise<AgentTranscriptionResponse> {
    const tenantId = this.requireTenant();
    if (!body?.mediaId) throw new BadRequestException('`mediaId` is required.');
    if (!this.jobService || !this.realtimeService || !this.mediaService || !this.asrResolver) {
      throw new HttpException({ detail: 'Batch transcription is not configured on this gateway' }, HttpStatus.SERVICE_UNAVAILABLE);
    }
    // TASK-861 — one resolution: explicit slug → PUBLISHED ACTIVE SPEECH_TO_TEXT agent
    // (404-over-403 inside) → ResolvedAsrSpec. Credentials never enter the job row or
    // the queue message; the worker pulls them at execution time.
    const { spec } = await this.asrResolver.resolve({ tenantId, agentSlug: slug, departmentId: null });
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
        pipelineId: spec.runtimeKey,
        resolvedSpec: spec,
        audioUri: media.uri,
        consultationId: body.consultationId,
        mediaId: body.mediaId,
        language: body.language,
        userId: this.cls.get('user')?.id,
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
      pipelineId: spec.runtimeKey,
      sseUrl: `/api/v1/audio/transcription-jobs/${job.id}/stream`,
    };
  }

  /**
   * The blocking invocation's ledger batch, from the bare token counts TEXT
   * returned.
   *
   * Deliberately NOT `buildLlmUsageInput`: that builder needs a `usage_detail`
   * block (endpoint kind, the raw provider usage object, the cache/reasoning
   * split), and the blocking invocation result carries only
   * `{promptTokens, completionTokens}`. Fabricating an `endpointKind` to reach
   * the richer builder would stamp an API shape that never happened, so this
   * uses the counts-only builder that exists for exactly this case.
   *
   * FUNDING IS DERIVED, NEVER STAMPED (rule 09): `fundingTier === 'tenant'`
   * means the tenant's own credential served the call, which is BYOK whichever
   * vendor answered; only an unfunded call lets the provider decide
   * self-hosted vs cloud.
   */
  private buildBlockingUsage(tenantId: string, resolved: ResolvedAgent, result: AgentTextInvocationResult): UsageEventBatchInput | null {
    if (!result.usage) return null;
    const byok = resolved.fundingTier === 'tenant';
    const provider = toLedgerProvider(result.provider ?? resolved.compiledConfig.model.provider ?? '');
    const batch = buildLlmUsageInputFromTokenCounts({
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
    });
    if (!batch) return null;
    // `costBasis` is never derived from `deployment` (usage-event.input.ts): a
    // BYOK emitter states it, or the row defaults to INTERNAL and over-reports
    // platform spend — the safe direction, but wrong for a tenant-funded call.
    const funded = byok ? { ...batch, common: { ...batch.common, costBasis: AiCostBasis.BYOK_NOTIONAL } } : batch;
    return withUsageTrigger(funded, AGENT_INVOCATION_TRIGGER);
  }

  /**
   * Fire-and-forget emission. The generation already happened and the caller
   * already has its bytes: a metering failure must degrade to "not metered",
   * never to a broken response.
   */
  private emitInvocationUsage(batch: UsageEventBatchInput | null, agentSlug: string, guardrail?: GuardrailDisposition): void {
    if (!batch || !this.usageLedger) return;
    // `guardrail` is stamped on GENERATION rows only. The speech path passes none, and that is
    // the honest answer rather than an omission: a TTS call never reaches the guardrail gate, so
    // the dimension does not apply — which the allow-list models as an absent key, never as a
    // fabricated `screened`.
    const stamped = guardrail ? (withUsageAttributes(batch, { guardrail }) ?? batch) : batch;
    void this.usageLedger.recordUsage(stamped).catch((err: unknown) =>
      this.logger.warn({
        message: 'Agent invocation usage emission failed',
        agentSlug,
        error: err instanceof Error ? err.message : String(err),
      }),
    );
  }

  private requireTenant(): string {
    const tenantId = this.cls.get('tenantId');
    if (!tenantId) throw new BadRequestException('Tenant context required');
    return tenantId;
  }
}
