import { BadRequestException, ConflictException, Inject, Injectable, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { ClsService } from 'nestjs-cls';
import type { Readable } from 'node:stream';
import { AsrPipelineRepository, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { jsonSchemaValueProblems } from '@arcaai/json-schema-subset';
import {
  PromptCompositionEmptyError,
  PromptTemplateSyntaxError,
  PromptVariableUnresolvedError,
  composePrompt,
  outputSchemaResponseFormat,
  unresolvedPromptVariables,
} from '@arcaai/workflow-contract';
import type { ResolvedAgent } from '@arcaai/types';
import { TENANTLESS, internalServiceHeaders, resolveInternalAccessToken } from '../../common';
import type { IActiveUserContext } from '../../interfaces';
import { SecretsService } from '../baseServices/_meta/secrets';
import { TextRequestEnrichmentService } from '../text-request/text-request-enrichment.service';
import { COMPUTE_DEVICES, type ComputeDevice, type GuardrailDisposition } from '../usageLedger/usage-attributes';
import {
  CONTEXT_NAMESPACE_ROOT,
  soleContextKindSchema,
  unwrapSingleKindContextPayload,
  type UserIdentityBinding,
} from '../consultation-context-schema/context-schema-definition';
import { IContextUserIdentityService, extractUserIdentityValue } from '../user/identity';
import { buildAgentPromptScope } from './agent-prompt-scope';
import { promptVariableSlot, type PromptVariableSlot } from './agent-required-variables';
import { wireModelIdOf } from './agent-wire-model';

export interface AgentTextInvocationResult {
  text: string;
  provider: string | null;
  model: string | null;
  usage: { promptTokens: number | null; completionTokens: number | null } | null;
  /**
   * TASK-957 F-2 — TEXT's own `usage_detail` block, VERBATIM.
   *
   * The flat `usage` above is the DEPRECATED two-count summary, and billing from it discards
   * everything an invoice is reconstructed from: the task id the idempotency key must derive
   * from (so a ledger row can be joined to TEXT's persisted task log), the cache-read/write and
   * reasoning split, the `endpoint_kind` the rater branches on, the BYOK flag, the connection id
   * — and, since TASK-959, `total_ms` / `engine_ms` and the vendor byte counts.
   *
   * Handed back UNPARSED on purpose: `parseTextUsageDetail` is the ONE reader of this shape and
   * it lives with the emitters. A second interpretation here would be a second thing to keep in
   * step with TEXT, and the stream path already goes through that one reader.
   *
   * `null` = TEXT sent no block (an older service, or a response that carried nothing) — the
   * caller then falls back to the counts-only builder rather than fabricating an endpoint kind.
   */
  usageDetail?: Record<string, unknown> | null;
  /**
   * TASK-957 F-3 — the guardrail call TEXT made ON THIS REQUEST'S BEHALF, same shape, verbatim.
   *
   * COGS, never a tenant line (D16): the platform mandates the screening, so it belongs in
   * per-encounter margin. Dropped entirely on this plane until now, which undercounted every
   * agent-plane guardrail call.
   */
  guardrailUsage?: Record<string, unknown> | null;
  /**
   * TASK-947 (OD-11) — which prompt fragments this call actually ran, for a composite agent;
   * `null` for the two single-body instruction forms, which have no composition to report.
   *
   * KEYS ONLY. A fragment BODY and a `when` string are both authored clinical text and can carry
   * PHI, so neither leaves the renderer — the key is what an author needs to see which branch
   * ran, and it is all telemetry ever needs.
   */
  promptFragments: { selected: string[] } | null;
  /**
   * TASK-950 (decision 3, fast win) — the clinician this invocation acted FOR, as resolved from
   * the agent's frozen context schema for a MACHINE caller.
   *
   * INTERNAL, and deliberately not on `AgentTextInvocationResponse`: the caller supplied the staff
   * id, so echoing the user it maps to adds nothing but a directory lookup for anyone holding a
   * credential. Its one consumer is the gateway's usage emission, which stamps it as
   * `AiUsageEvent.doctorId` — the same durable, indexed, billing-grade column a consultation call
   * already fills.
   *
   * ABSENT means there was nothing to resolve, which `resolveContextUserIdentity` documents four
   * honest ways (human caller · no `userIdentity` marker · marker declared but no value sent ·
   * value not a string). Anything the resolver REFUSES throws instead of arriving here.
   */
  actingUserId?: string;
}

/** The `mode: 'stream'` return of {@link AgentInvocationService.invokeText}. */
export interface AgentTextStreamInvocation {
  stream: Readable;
  /** Same contract as {@link AgentTextInvocationResult.actingUserId} — resolved before the model call, so it is known at stream START. */
  actingUserId?: string;
}

/** TASK-930 §2.3 — ONE extracted span, in the agent's output vocabulary rather than `apps/nlp`'s. */
export interface AgentNerEntity {
  text: string;
  label: string;
  start: number;
  end: number;
  score?: number;
}

export interface AgentNerInvocationResult {
  entities: AgentNerEntity[];
  /** The model id actually sent on the wire — what the usage row attributes the call to. */
  model: string | null;
  /** Characters SENT, the unit `ner.extract` meters on. Counted here so the caller cannot disagree with the wire. */
  charCount: number;
  /**
   * TASK-959 §3.2 — wall-clock milliseconds `apps/nlp` spent in the model for THIS call
   * (`inference_ms`, on every inference response since the P-NLP lane). `null` when the service
   * reported none: a compute row nobody measured is worse than no compute row.
   */
  inferenceMs: number | null;
  /**
   * TASK-959 §3.1 — the device the checkpoint was resolved onto (`cuda` / `mps` / `cpu`), which
   * DECIDES the unit (`GPU_SECOND` vs `CPU_SECOND`) rather than describing it. `null` for an
   * absent value AND for a spelling outside the closed vocabulary — a near-miss like `gpu` must
   * not be coerced into the expensive unit.
   */
  device: ComputeDevice | null;
}

/** The TTS forward body the gateway's speech proxy already speaks (`SpeechSynthesizeRequest`). */
export interface AgentSpeechRequest {
  input: string;
  voice: string;
  response_format?: 'pcm' | 'wav' | 'mp3';
  speed?: number;
  model?: string;
  language?: string;
  ssml?: boolean;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/**
 * TASK-957 F-2/F-3 — a usage block TEXT sent, or `null`.
 *
 * Unlike {@link asRecord} this does NOT degrade a missing block to `{}`: an empty object would
 * reach `parseTextUsageDetail` as a block with no `endpoint_kind`, which it rejects anyway — but
 * the caller's "did TEXT report usage at all" test must stay a question about presence, not a
 * question about emptiness.
 */
function usageBlock(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

/** TASK-959 — a positive integer millisecond reading, or `null`. Zero is "nothing to record". */
function positiveMs(value: unknown): number | null {
  const parsed = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  return Number.isFinite(parsed) && parsed > 0 ? Math.round(parsed) : null;
}

/**
 * TASK-959 §3.1 — a device from the CLOSED vocabulary, or `null`.
 *
 * The value decides a UNIT (`cuda`/`mps` → `GPU_SECOND`, `cpu` → `CPU_SECOND`), and the two are
 * priced an order of magnitude apart, so a near-miss spelling is refused here rather than at
 * emit time — by then the unit has already been chosen.
 */
function computeDevice(value: unknown): ComputeDevice | null {
  return typeof value === 'string' && (COMPUTE_DEVICES as readonly string[]).includes(value) ? (value as ComputeDevice) : null;
}

/**
 * Executes a RESOLVED agent (TASK-863 §3.5). TEXT_GENERATION goes through the existing
 * `apps/text` `/api/v1/generate` call path with the same enrichment every sanctioned caller
 * applies (`applyTextRuntimeProfile` then `applyTenantProviderOverrides` — never a new HTTP
 * client, never a credential of its own). TTS and batch ASR are PREPARED here and executed by
 * the gateway's existing speech proxy / transcription-job path.
 */
@Injectable()
export class AgentInvocationService {
  private readonly logger = new Logger(AgentInvocationService.name);
  private readonly textServiceUrl: string;
  private readonly nlpServiceUrl: string;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    private readonly textRequestEnrichment: TextRequestEnrichmentService,
    @Optional() private readonly secretsService?: SecretsService,
    @Optional() private readonly asrPipelineRepository?: AsrPipelineRepository,
    // TASK-950 (D-5) — this service is the ONLY place the agent plane can see WHO is calling,
    // and it needs to: a machine caller resolves the schema's user-identity field and a human
    // one must not. `@Optional()` and TRAILING because the class does not extend `BaseService`
    // (it broadcasts nothing and tracks no entity) and every existing unit test constructs it
    // with three positional arguments; a required parameter here would break them, and a
    // base-class change would give every invocation an audit row nobody asked for. Absent CLS
    // means no service account is observable, so the identity path is simply not taken —
    // exactly the answer a human caller already gets.
    @Optional() private readonly clsService?: ClsService<IActiveUserContext>,
    // The find-or-provision resolver (TASK-950 L1), wired by `AgentServiceModule`. `@Optional()`
    // for the same construction reason, but NEVER silently skipped: a call that HAS a frozen
    // binding, a machine caller and a supplied value and finds no resolver raises 503. Silence
    // there would drop the clinician on the floor and leave nothing behind saying so.
    @Optional() @Inject(IContextUserIdentityService) private readonly userIdentity?: IContextUserIdentityService,
  ) {
    // Bootstrap TRANSPORT address (rule 00): the only sanctioned env default.
    this.textServiceUrl = this.configService.get<string>('TEXT_URL') ?? 'http://localhost:8862';
    this.nlpServiceUrl = this.configService.get<string>('NLP_URL') ?? 'http://localhost:8864';
  }

  /** TIER 3 — the invocation body against the agent's declared `inputSchema`. */
  inputProblems(resolved: ResolvedAgent, input: unknown): string[] {
    return jsonSchemaValueProblems(resolved.compiledConfig.inputSchema, input);
  }

  /**
   * TIER 3 (TASK-890 §3.4) — the request's `context` object against the agent's BOUND context
   * schema, as FROZEN into `compiledConfig.contextSchema.payloadSchema` at publish time.
   *
   * Frozen, not resolved: the runtime never reads a schema row (invariant 4), so a tenant that
   * edits its schema after publishing does not silently change what a published agent accepts.
   * An agent that binds no schema declares no `context` vocabulary, so there is nothing to
   * check and nothing to refuse — `[]`, not "everything is invalid".
   */
  contextProblems(resolved: ResolvedAgent, context: unknown): string[] {
    const payloadSchema = boundContextPayloadSchema(resolved);
    if (payloadSchema === null) return [];
    // J3-5 — a schema declaring ONE kind keyed `context` has no envelope worth carrying, so the
    // agent path validates the kind's own schema against the flat payload (either shape reaches
    // the same object). Every other schema is checked against the envelope, verbatim.
    const soleKind = soleContextKindSchema(payloadSchema);
    if (soleKind === null) return jsonSchemaValueProblems(payloadSchema, context ?? {});
    return jsonSchemaValueProblems(soleKind, unwrapSingleKindContextPayload(payloadSchema, context ?? {}) ?? {});
  }

  /**
   * The object `{{context.*}}` resolves against for THIS agent (J3-5).
   *
   * Under the single-kind rule both call shapes converge: an invocation caller sends the flat
   * kind object and a workflow trigger arrives as the envelope, and one unwrap answers both — so
   * the same prompt renders identically here, on the draft bench, and on the durable lane's
   * `_prompt_scope` mirror.
   */
  private contextScopeFor(resolved: ResolvedAgent, context: unknown): Record<string, unknown> | undefined {
    const payloadSchema = boundContextPayloadSchema(resolved);
    const resolvedContext = payloadSchema === null ? context : unwrapSingleKindContextPayload(payloadSchema, context);
    return resolvedContext !== null && typeof resolvedContext === 'object' && !Array.isArray(resolvedContext)
      ? (resolvedContext as Record<string, unknown>)
      : undefined;
  }

  async invokeText(resolved: ResolvedAgent, tenantId: string, input: Record<string, unknown>, mode: 'blocking'): Promise<AgentTextInvocationResult>;
  async invokeText(resolved: ResolvedAgent, tenantId: string, input: Record<string, unknown>, mode: 'stream'): Promise<AgentTextStreamInvocation>;
  async invokeText(
    resolved: ResolvedAgent,
    tenantId: string,
    input: Record<string, unknown>,
    mode: 'blocking' | 'stream',
  ): Promise<AgentTextInvocationResult | AgentTextStreamInvocation> {
    if (resolved.task !== 'TEXT_GENERATION') {
      throw new BadRequestException(`Agent '${resolved.slug}' is a ${resolved.task} agent; invocations apply to TEXT_GENERATION agents only.`);
    }
    // TIER 3 (§3.4) — enforced HERE rather than only at the controller, so every caller of this
    // service (the route, the draft test, a future job) gets the same refusal for the same
    // reason. A context the agent's frozen schema does not admit never reaches a model.
    const contextProblems = this.contextProblems(resolved, input.context ?? {});
    if (contextProblems.length > 0) {
      // The SAME named refusal the draft bench raises (`AgentService.assertContextConforms`), so a
      // caller that fixed a violation on the bench recognises it if it recurs in production.
      throw new BadRequestException({
        message: `The supplied context does not satisfy the schema agent '${resolved.slug}' binds (version ${
          resolved.compiledConfig.contextSchema?.versionNumber ?? 'unknown'
        }).`,
        code: 'CONTEXT_SCHEMA_VIOLATION',
        findings: contextProblems,
      });
    }

    // TASK-950 (D-3/D-5/D-6) — the schema's USER-IDENTITY field, resolved to a tenant user.
    //
    // AFTER the context gate on purpose: a context the agent's frozen schema does not admit is a
    // 400, and a refused request must never provision a user as a side effect. BEFORE the model
    // call for the mirror-image reason — the acting clinician is decided, and any refusal about
    // them raised, while nothing has been spent.
    //
    // Covers BOTH modes: `blocking` and `stream` reach the model through this one method, so
    // there is one insertion here and no second gate to keep in step.
    //
    // TASK-950 (decision 3, fast win) — the answer is now RETURNED as well as logged, so the
    // gateway can stamp it on this call's usage row (`AiUsageEvent.doctorId`). Captured here, at
    // the single resolution point, and carried to both returns below: the stream return happens
    // after the model call, and re-resolving there could provision a second time.
    const actingUserId = await this.resolveContextUserIdentity(resolved, tenantId, input);
    const actingUser: { actingUserId?: string } = actingUserId ? { actingUserId } : {};

    const compiled = resolved.compiledConfig;
    const parameters = asRecord(compiled.parameters);
    const generation = asRecord(parameters.generation);
    const boundVariables = asRecord(asRecord(compiled.instruction).variables);
    const variables = { ...boundVariables, ...asRecord(input.variables) };
    // TASK-890 §3.3 — the SAME scope the workflow lanes build: `input.*` (this body), `context.*`
    // (the request's context object, already validated against the agent's frozen schema by the
    // controller through `contextProblems`) and the bare bound names, caller's winning.
    // Scope construction is inside the same failure mapping as the render: a `{ path }` binding
    // is resolved through the same grammar, so an unresolvable binding is the caller's 400
    // naming the path, not a 500.
    // TASK-947 — the render goes through `composePrompt`, which is the ONE entry point for all
    // three instruction forms: the two single-body shapes pass straight through it (`selected:
    // []`), and a composite selects its fragments over THIS scope — the same object the
    // templates render against, so what a condition saw and what the prompt saw cannot differ.
    const composed = this.renderScoped(resolved.slug, () => {
      const scope = buildAgentPromptScope({
        variables,
        input,
        trigger: this.contextScopeFor(resolved, input.context),
        templateRef: `agent:${resolved.slug}`,
      });
      // TASK-983 R9 — EVERY missing placeholder, in one refusal, BEFORE the render.
      // `renderTemplate` throws on the first one, so an agent whose instruction reads nine
      // context paths was discoverable only as nine consecutive 400s (measured on the dev
      // gateway, 2026-09-17). The diff runs over the SAME scope the render will use and the
      // SAME traversal, so it can neither over- nor under-report what the render would reject.
      this.assertPromptVariablesSupplied(resolved.slug, compiled.instruction, compiled.resolvedPrompt, scope);
      return composePrompt(compiled.resolvedPrompt, scope, { templateRef: `agent:${resolved.slug}` });
    });
    const systemPrompt = composed.prompt ?? undefined;
    const promptFragments = compiled.resolvedPrompt?.source === 'composite' ? { selected: [...composed.selected] } : null;
    // TASK-947 R2 M-1 — an exclusion left NO server-side record on this lane, so a safety fragment
    // dropped by a wrong-typed caller input was unreconstructible. Keys and reasons only (never the
    // evaluator's detail, which can echo a scope value): a `condition_error` is always an authoring
    // or contract defect and gets WARN; a `condition_false` is ordinary traffic and gets DEBUG.
    if (composed.excluded.length > 0) {
      const entry = {
        message: 'Composite instruction: fragments excluded for this call',
        agentSlug: resolved.slug,
        agentVersionId: resolved.agentVersionId,
        excluded: composed.excluded.map(({ key, reason }) => ({ key, reason })),
      };
      if (composed.excluded.some((exclusion) => exclusion.reason === 'condition_error')) this.logger.warn(entry);
      else this.logger.debug(entry);
    }

    // TASK-890 F9 — what goes on the wire is the ROUTED id (`AiModel.wireModelId`), never the
    // catalogue slug. Resolved BEFORE the body is built so an unroutable row is a named refusal
    // here rather than a 502 relayed from an engine that was handed a name it does not know.
    const wireModel = this.requireWireModelId(resolved);

    const body: Record<string, unknown> = {
      prompt: String(input.text ?? ''),
      ...(systemPrompt ? { system_prompt: systemPrompt } : {}),
      ...(compiled.model.provider ? { provider: compiled.model.provider } : {}),
      model: wireModel,
      ...(typeof generation.temperature === 'number' ? { temperature: generation.temperature } : {}),
      ...(typeof generation.maxTokens === 'number' ? { max_tokens: generation.maxTokens } : {}),
      ...(typeof generation.topP === 'number' ? { top_p: generation.topP } : {}),
      // TASK-930 §5 — the author's explicit `responseFormat` first; failing that, the agent's own
      // DECLARED `outputSchema` as a `json_schema` constraint. Without the second half the column
      // was documentation: an agent could promise `{ case_note, redactions }` and be handed prose.
      ...agentResponseFormat(resolved.slug, compiled.outputSchema, parameters),
      stream: mode === 'stream',
      context: { agentSlug: resolved.slug, agentVersionId: resolved.agentVersionId },
    };
    // The same enrichment order every sanctioned `/api/v1/generate` caller uses: hyper-parameter
    // profile first, then the tenant → SYSTEM credential fold (`provider_overrides`, funding).
    // TASK-891 — `generation` is passed because the agent's REASONING posture (OD-4) is the one
    // hyper-parameter with no first-class field on `GenerateRequest`: it travels on the `extra`
    // ride-along, which is what this call builds. Without it an agent whose author turned
    // reasoning off still reasoned here — on the very surface a tenant admin uses to check the
    // control they just set.
    await this.textRequestEnrichment.applyTextRuntimeProfile(body as { provider?: string; model?: string }, generation);
    // TASK-958 D-3/D-4 — the RESOLVED agent's own credential is authoritative for this
    // call. The agent's primary model may be declared on a NON-default connection, and
    // `applyTenantProviderOverrides` folds by PROVIDER NAME (the tenant's default row),
    // so without this an agent bound to the second OpenAI account would be forwarded
    // on the first one's key and metered against it. The enrichment returns early when
    // `provider_overrides` is already present, which is exactly the contract it states.
    const resolvedOverride = resolved.providerOverride;
    if (resolvedOverride) {
      const { provider: overrideProvider, ...entry } = resolvedOverride;
      (body as { provider_overrides?: Record<string, unknown> }).provider_overrides = { [overrideProvider]: entry };
    }
    await this.textRequestEnrichment.applyTenantProviderOverrides(body as { provider?: string });
    // TASK-890 §3.14 (OD-R) — the guardrail decision for THIS call. A standalone invocation has
    // no workflow and no node, so the AGENT tier is the whole precedence: `ResolvedAgent.guardrail`
    // is what `resolveGuardrailDecision` would answer with `node`/`workflow` absent, already
    // normalised by the resolver (absent or malformed ⇒ screening ON).
    //
    // Stated EXPLICITLY in both directions so TEXT can tell "screened because a decision said so"
    // from "no opinion", and safe to send unconditionally because it can only ever subtract —
    // `apps/text` keeps the platform switch as the floor.
    // `?? { enabled: true }` is the fail-SAFE read, not a default with an opinion: `guardrail` is
    // non-optional on `ResolvedAgent` and the resolver normalises it, but an answer built before
    // this ticket carries none — and on a safety gate an absent value must read as SCREENED.
    this.textRequestEnrichment.applyGuardrailDecision(body, resolved.guardrail ?? { enabled: true });

    const headers = internalServiceHeaders({
      serviceToken: await resolveInternalAccessToken(this.secretsService, 'INTERNAL_ACCESS_TOKEN'),
      tenantId,
      tenantlessReason: TENANTLESS.CONTROL_PLANE,
    });

    if (mode === 'stream') {
      const response = await this.httpService.axiosRef.post(`${this.textServiceUrl}/api/v1/generate`, body, {
        headers: { ...headers, Accept: 'text/event-stream' },
        responseType: 'stream',
      });
      return { stream: response.data as Readable, ...actingUser };
    }

    const response = await this.httpService.axiosRef.post(`${this.textServiceUrl}/api/v1/generate`, body, { headers });
    const data = (response.data ?? {}) as {
      content?: string;
      summary?: string;
      provider?: string;
      model?: string;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
      usage_detail?: unknown;
      guardrail_usage?: unknown;
    };
    return {
      text: data.content ?? data.summary ?? '',
      provider: data.provider ?? compiled.model.provider ?? null,
      model: data.model ?? wireModel,
      usage: data.usage ? { promptTokens: data.usage.prompt_tokens ?? null, completionTokens: data.usage.completion_tokens ?? null } : null,
      // TASK-957 F-2 / F-3 — carried, not interpreted. See the field docs on
      // `AgentTextInvocationResult`.
      usageDetail: usageBlock(data.usage_detail),
      guardrailUsage: usageBlock(data.guardrail_usage),
      promptFragments,
      ...actingUser,
    };
  }

  /**
   * TASK-930 §2.4 — run a `NAMED_ENTITY_RECOGNITION` agent against `apps/nlp`.
   *
   * ## Why this is not `invokeText` with a different URL
   *
   * Token classification is a ONE-SHOT pass over the whole document: there is no prompt to
   * assemble, no session to stream and no provider credential to fold in. `apps/nlp` serves it
   * from platform-hosted weights, which is exactly why `AGENT_TASK_SERVICE.NAMED_ENTITY_RECOGNITION`
   * is `null` — there is no `AiProviderConnection` plane to consult, so none is consulted here.
   *
   * ## What goes on the wire
   *
   * The route's `model_name` is REQUIRED (an absent one is a 503 at `apps/nlp`, by design), so it
   * is resolved from the agent's own materialised primary row rather than guessed: the declared
   * `wireModelId` when the row has one, and the catalogue LOCATOR (`sourceUri`) otherwise —
   * which is the normal case for the `built-in` NER catalogue, whose rows route by HF id and
   * legitimately declare no wire id (the publish gate exempts `platform-self-host` for exactly
   * this reason). `model_path` rides along when the resolver derived one.
   *
   * `labels` is the agent's INSTRUCTION (what to look for; an open-taxonomy extractor refuses
   * without it and a closed-taxonomy checkpoint ignores it), while `threshold` / `aggregation`
   * are its PARAMETERS (how hard to look). Each is omitted when the agent declared none, so the
   * checkpoint's own declaration keeps applying rather than being overwritten by a literal
   * chosen here.
   *
   * `X-Tenant-Id` is mandatory on this hop (owner directive 2026-08-16): an invocation always
   * has a tenant, so there is no tenant-less branch to declare.
   */
  async invokeNer(resolved: ResolvedAgent, tenantId: string, input: Record<string, unknown>): Promise<AgentNerInvocationResult> {
    if (resolved.task !== 'NAMED_ENTITY_RECOGNITION') {
      throw new BadRequestException(
        `Agent '${resolved.slug}' is a ${resolved.task} agent; entity extraction applies to NAMED_ENTITY_RECOGNITION agents only.`,
      );
    }
    const text = typeof input.text === 'string' ? input.text : '';
    if (text.length === 0) throw new BadRequestException('Provide `text` to extract entities from.');

    const compiled = resolved.compiledConfig;
    const parameters = asRecord(compiled.parameters);
    const instruction = asRecord(compiled.instruction);
    const primary = resolved.models.find((model) => model.role === 'primary');
    // Refused HERE rather than relayed: `apps/nlp` answers 503 "model not available" for an
    // absent `model_name`, which names neither this agent nor the row it binds.
    const modelName = wireModelIdOf(resolved) ?? primary?.sourceUri ?? null;
    if (!modelName) {
      throw new ConflictException({
        message:
          `Agent '${resolved.slug}' binds model '${compiled.model.slug}', which resolves to no checkpoint id, ` +
          'so there is nothing to send as `model_name` for token classification.',
        code: 'AGENT_MODEL_WIRE_ID_MISSING',
      });
    }

    const labels = Array.isArray(instruction.labels)
      ? (instruction.labels as unknown[]).filter((label): label is string => typeof label === 'string')
      : [];
    const body: Record<string, unknown> = {
      text,
      model_name: modelName,
      ...(primary?.localPath ? { model_path: primary.localPath } : {}),
      ...(typeof input.language === 'string' ? { language: input.language } : {}),
      ...(labels.length > 0 ? { labels } : {}),
      ...(typeof parameters.threshold === 'number' ? { threshold: parameters.threshold } : {}),
      ...(typeof parameters.aggregation === 'string' ? { aggregation_strategy: parameters.aggregation } : {}),
    };

    const headers = internalServiceHeaders({
      serviceToken: await resolveInternalAccessToken(this.secretsService, 'NLP_SERVICE_TOKEN'),
      tenantId,
      tenantlessReason: TENANTLESS.CONTROL_PLANE,
    });

    const response = await this.httpService.axiosRef.post(`${this.nlpServiceUrl}/api/v1/classify/tokens`, body, { headers });
    const data = asRecord(response.data);
    return {
      entities: mapNerEntities(response.data),
      model: modelName,
      charCount: [...text].length,
      // TASK-959 §3.2 — what apps/nlp measured, or nothing. Both readers refuse to guess: an
      // unmeasured call records characters and no compute, which is the correctable direction.
      inferenceMs: positiveMs(data.inference_ms),
      device: computeDevice(data.device),
    };
  }

  /**
   * TASK-950 §C5 — resolve the schema-declared user identity for a MACHINE caller, or answer
   * `null` because there is nothing to resolve.
   *
   * Four ways this legitimately answers `null`, none of them an error:
   *   · a HUMAN caller (a JWT, or an API key bound to a human) — D-5: the caller already IS the
   *     clinician, so naming a different one would be an impersonation, not a mapping;
   *   · the agent's frozen schema declares no `userIdentity` marker;
   *   · the marker is declared but this request supplied no value (D-2: presence is governed by
   *     the schema's own `required` flags, never by the marker);
   *   · the supplied value is not a string — the payload schema already ruled on its type, so
   *     this is a shape check, not a second validator.
   *
   * The binding is read STRUCTURALLY off the FROZEN `compiledConfig`, never from a schema row
   * (TASK-890 invariant 4): a tenant that edits its schema after publishing does not silently
   * change which field a published agent treats as identity.
   *
   * Everything the resolver refuses — 400 `USER_IDENTITY_INVALID` /
   * `USER_IDENTITY_DEPARTMENT_UNRESOLVED`, 404 `USER_IDENTITY_UNKNOWN` /
   * `USER_IDENTITY_NOT_USABLE`, 409 `USER_IDENTITY_AMBIGUOUS`, 409 seat quota — propagates
   * VERBATIM. This lane adds no translation layer: an integrator that has to fix its staff-id
   * mapping needs the resolver's own code, not a paraphrase of it.
   */
  private async resolveContextUserIdentity(resolved: ResolvedAgent, tenantId: string, input: Record<string, unknown>): Promise<string | null> {
    const serviceAccount = this.clsService?.get('serviceAccount') ?? null;
    if (!serviceAccount) return null;

    const binding = boundUserIdentityBinding(resolved);
    if (binding === null) return null;

    const staffId = identityValueOf(resolved, input.context, binding);
    if (staffId === undefined) return null;

    if (!this.userIdentity) {
      // Fail LOUD. An unwired resolver on a request that CARRIES a clinician is not the same
      // thing as a request without one: answering as though the field had not been sent would
      // run the agent under no acting user and leave no record that one was named.
      throw new ServiceUnavailableException({
        message: 'This agent binds a context schema that declares a user-identity field, but the identity resolver is not configured.',
        code: 'USER_IDENTITY_RESOLVER_UNAVAILABLE',
      });
    }

    const { userId, provisioned } = await this.userIdentity.resolveOrProvision({
      tenantId,
      staffId,
      // D-9/OD-8 — an agent invocation names no department, so the resolver falls to the tenant's
      // `identity.autoProvision.departmentId` setting and fails closed when that is unset too.
      // `null` is this plane HAVING no department, never "any department will do".
      departmentId: null,
      provenance: {
        plane: 'agent-invocation',
        kindKey: binding.kindKey,
        field: binding.field,
        serviceAccountId: serviceAccount.id,
        ...(resolved.compiledConfig.contextSchema
          ? { schemaId: resolved.compiledConfig.contextSchema.schemaId, versionNumber: resolved.compiledConfig.contextSchema.versionNumber }
          : {}),
      },
    });

    // ATTRIBUTION, such as this plane has. `AgentInvocationService` broadcasts no sys-event and
    // writes no `AgentTrajectory` row — trajectories belong to the consultation and harness
    // lanes, and a standalone invocation is neither — so there is no existing durable record to
    // stamp an `actingUserId` onto, and minting one would give every invocation an audit row
    // nobody asked for. The DURABLE trail is the resolver's own `ResourceCreated` events (which
    // carry this `provenance`, service account included) plus `_metadata.provisioning` on the new
    // `User`; this line is the operational one. NEVER the staff id itself — it is the tenant's own
    // identifier for a person and may be PII (D-8), which is also why it never enters a username.
    this.logger.log({
      message: 'agent.invocation.identity_resolved',
      agentSlug: resolved.slug,
      agentVersionId: resolved.agentVersionId,
      tenantId,
      kindKey: binding.kindKey,
      field: binding.field,
      serviceAccountId: serviceAccount.id,
      actingUserId: userId,
      provisioned,
    });

    return userId;
  }

  /**
   * The provider-native id for this agent's primary model, or a NAMED refusal.
   *
   * Every provider `apps/text` serves is engine-served or cloud (lm-studio, ollama, vllm,
   * llama-cpp, azure, bedrock) and each routes by a vendor id, so a TEXT_GENERATION agent whose
   * row declares none cannot be invoked at all — which is what `toTextCandidate` already says by
   * DROPPING such a candidate, and what the publish gate says by refusing the publish. Saying it
   * here too keeps a version published before that gate from failing as an opaque upstream 502.
   *
   * 409 rather than 400: the caller's request is well formed; the agent's binding is not.
   */
  private requireWireModelId(resolved: ResolvedAgent): string {
    const wireModel = wireModelIdOf(resolved);
    if (wireModel) return wireModel;
    throw new ConflictException({
      message:
        `Agent '${resolved.slug}' binds model '${resolved.compiledConfig.model.slug}', which declares no wire model id, ` +
        `so there is nothing to send as the model name for provider '${resolved.compiledConfig.model.provider ?? '(none)'}'. ` +
        'Set `wireModelId` on the catalogue row, then re-resolve.',
      code: 'AGENT_MODEL_WIRE_ID_MISSING',
    });
  }

  /**
   * TASK-890 §3.14 — the SCREENING DISPOSITION this call's ledger row records.
   *
   * Delegated to the enrichment service (which owns the platform-switch read) rather than
   * duplicated at the controller: the same service writes the wire field above, so "what we
   * asked TEXT to do" and "what we recorded having done" are derived in ONE place and cannot
   * drift into disagreeing about the same call.
   */
  async guardrailDisposition(decision: { enabled: boolean }): Promise<GuardrailDisposition> {
    return this.textRequestEnrichment.guardrailDisposition(decision);
  }

  /**
   * TASK-983 R9 — refuse an incomplete invocation ONCE, naming every placeholder it did not
   * supply and the request key each one belongs under.
   *
   * Selection-aware (`unresolvedPromptVariables` selects the composite's fragments over this
   * scope first): a conditional fragment this call excludes asks for nothing, so a body that
   * works is never refused for a branch it does not take.
   *
   * `suppliedUnder` is a MAP rather than one key, because a single prompt legitimately mixes
   * roots — `{{context.language}}`, `{{input.text}}` and a bare `{{tone}}` go to three different
   * places, and a scalar could only describe one of them. A path whose root no invocation can
   * supply (`vars.*`, `nodes.*` — workflow-only namespaces) is named in `missingVariables` and
   * carries no entry here: there is no key that would satisfy it, and inventing one would send
   * the caller to a field that does nothing.
   *
   * The per-path `PromptVariableUnresolvedError` mapping in {@link renderScoped} STAYS as the
   * defensive fallback: a `{ path }` binding is resolved while the scope is being built, which
   * is before this diff can run, and a malformed artifact must still refuse by name.
   */
  private assertPromptVariablesSupplied(
    agentSlug: string,
    instruction: Record<string, unknown> | null,
    resolvedPrompt: ResolvedAgent['compiledConfig']['resolvedPrompt'],
    scope: Readonly<Record<string, unknown>>,
  ): void {
    const missing = unresolvedPromptVariables(resolvedPrompt, scope);
    if (missing.length === 0) return;
    const boundNames = Object.keys(asRecord(asRecord(instruction).variables));
    const suppliedUnder: Record<string, PromptVariableSlot> = {};
    for (const path of missing) {
      const slot = promptVariableSlot(path, boundNames);
      if (slot !== null) suppliedUnder[path] = slot;
    }
    const where = missing.map((path) => `\`${path}\`${suppliedUnder[path] ? ` (send under \`${suppliedUnder[path]}\`)` : ''}`).join(', ');
    throw new BadRequestException({
      message:
        `Agent '${agentSlug}' instruction references ${missing.length} variable(s) this invocation does not supply: ${where}. ` +
        "Send each one under the request key named, or give the placeholder a `default(\"…\")`. " +
        'The full list is published as `requiredVariables` on `GET /api/v1/agents/' +
        `${agentSlug}\`.`,
      code: 'PROMPT_VARIABLES_MISSING',
      missingVariables: missing,
      suppliedUnder,
    });
  }

  /**
   * Render the agent's instruction through the ONE grammar (§3.2), turning its two named
   * failures into the 400 the caller can act on.
   *
   * A 400 rather than a 500 because both are the CALLER's: an unresolved placeholder means the
   * request did not supply what the agent's prompt declares, and a syntax error means the
   * published instruction is malformed (publish reports it as `PROMPT_TEMPLATE_SYNTAX`). Either
   * way nothing is sent upstream — a half-substituted prompt, or one carrying a literal
   * `{{…}}`, is the failure mode this grammar exists to end.
   */
  private renderScoped<T>(agentSlug: string, work: () => T): T {
    try {
      return work();
    } catch (error) {
      // TASK-947 (OD-6) — every fragment's condition was false or failed. Publish enforces an
      // unconditional base fragment, so this is the defensive half: an artifact published before
      // that rule, or hand-written, must be a NAMED refusal rather than a call to TEXT with no
      // system prompt at all. The excluded KEYS ride along (never a body, never a condition).
      if (error instanceof PromptCompositionEmptyError) {
        throw new BadRequestException({
          message: `Agent '${agentSlug}' selected no prompt fragment for this call: every fragment's condition was false or could not be evaluated.`,
          code: 'PROMPT_COMPOSITION_EMPTY',
          excluded: error.excluded.map((exclusion) => ({ key: exclusion.key, reason: exclusion.reason })),
        });
      }
      if (error instanceof PromptVariableUnresolvedError) {
        throw new BadRequestException(
          `Agent '${agentSlug}' instruction references \`${error.path}\`, which this invocation does not supply. Provide it under \`context\` / \`input\` / \`variables\`, or give the placeholder a \`default("…")\`.`,
        );
      }
      if (error instanceof PromptTemplateSyntaxError) {
        // The parser's own message rides as a FIELD, never interpolated into a composed body:
        // `downstream-error-leak-sweep.test.ts` sweeps every call site in these two packages for
        // that shape because it is how a `host:port` reached a client once already. The structured
        // form is also what the draft bench raises (`AgentService.render`), so a caller sees one
        // code for one failure on both surfaces.
        throw new BadRequestException({
          message: `Agent '${agentSlug}' instruction is not a valid template.`,
          code: 'PROMPT_TEMPLATE_SYNTAX',
          detail: error.message,
        });
      }
      throw error;
    }
  }

  /** The agent-derived half of a TTS request; the gateway merges the tenant's TTS config + BYO overrides on top. */
  buildSpeechRequest(resolved: ResolvedAgent, input: Record<string, unknown>): AgentSpeechRequest {
    if (resolved.task !== 'TEXT_TO_SPEECH') {
      throw new BadRequestException(`Agent '${resolved.slug}' is a ${resolved.task} agent; speech applies to TEXT_TO_SPEECH agents only.`);
    }
    const parameters = asRecord(resolved.compiledConfig.parameters);
    const text = typeof input.text === 'string' ? input.text : undefined;
    const ssml = typeof input.ssml === 'string' ? input.ssml : undefined;
    if (!text && !ssml) throw new BadRequestException('Provide `text` or `ssml`.');
    if (ssml && parameters.ssml !== true) throw new BadRequestException('This agent does not accept SSML input.');
    const voice = typeof parameters.voice === 'string' ? parameters.voice : undefined;
    if (!voice) throw new BadRequestException(`Agent '${resolved.slug}' declares no voice.`);
    return {
      input: (ssml ?? text) as string,
      voice,
      ...(typeof parameters.format === 'string' && parameters.format !== 'ogg'
        ? { response_format: parameters.format as 'pcm' | 'wav' | 'mp3' }
        : {}),
      ...(typeof parameters.speed === 'number' ? { speed: parameters.speed } : {}),
      ...(typeof parameters.language === 'string' ? { language: parameters.language } : {}),
      // The ROUTED id when the row declares one; the slug otherwise. No refusal here: a
      // `built-in` TTS row (kokoro, indic-parler) legitimately declares none, and `apps/tts`
      // routes off `resolved_spec` rather than this field.
      model: wireModelIdOf(resolved) ?? resolved.compiledConfig.model.slug,
      ...(ssml ? { ssml: true } : {}),
    };
  }

  /**
   * TASK-861 RESOLVED — the gateway-resolved `ResolvedAsrSpec` replaced this: the agent
   * `transcriptions` route creates the job with `agentVersionId` + `resolvedSpec` and never
   * looks a pipeline row up. Kept for the deprecation window only. Picks the tenant's (then
   * SYSTEM's) enabled pipeline whose `models.asr` is the agent's primary model slug, else the
   * tenant default pipeline; `null` when nothing matches.
   */
  /** @deprecated TASK-861 — removed in R4. The agent `transcriptions` route resolves a `ResolvedAsrSpec` through `AsrAgentResolverService` (no pipeline lookup); this helper exists only for the window. */
  async resolveAsrPipelineId(resolved: ResolvedAgent, tenantId: string): Promise<string | null> {
    if (resolved.task !== 'SPEECH_TO_TEXT') {
      throw new BadRequestException(`Agent '${resolved.slug}' is a ${resolved.task} agent; transcriptions apply to SPEECH_TO_TEXT agents only.`);
    }
    if (!this.asrPipelineRepository) return null;
    const slug = resolved.compiledConfig.model.slug;
    const matcher = new RegExp(`^\\s*asr:\\s*["']?${slug.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']?\\s*$`, 'm');
    const tenants = tenantId === SYSTEM_TENANT_ID ? [SYSTEM_TENANT_ID] : [tenantId, SYSTEM_TENANT_ID];
    for (const owner of tenants) {
      const pipelines = await this.asrPipelineRepository.findEnabledPipelines(owner).catch(() => []);
      const match = pipelines.find((pipeline) => matcher.test(pipeline.configYaml ?? ''));
      if (match) return match.id;
    }
    const fallback = await this.asrPipelineRepository.findDefault(tenantId).catch(() => null);
    if (fallback) {
      this.logger.warn({
        message: 'No ASR pipeline matches the agent model; using the tenant default pipeline',
        tenantId,
        agentSlug: resolved.slug,
        modelSlug: slug,
      });
      return fallback.id;
    }
    return null;
  }
}

/**
 * The agent's FROZEN context payload schema, or `null` when it binds none.
 *
 * Read structurally rather than off a typed field: `AgentCompiledConfig.contextSchema`
 * (`packages/types/src/agent.ts`) is landed by L8/L14 in the same wave as this file, and a
 * compiled config stamped before that column existed simply carries nothing here. Absent is
 * "no vocabulary declared", never "invalid".
 */
function boundContextPayloadSchema(resolved: ResolvedAgent): Record<string, unknown> | null {
  const payloadSchema = resolved.compiledConfig.contextSchema?.payloadSchema;
  return payloadSchema !== null && typeof payloadSchema === 'object' && !Array.isArray(payloadSchema)
    ? (payloadSchema as Record<string, unknown>)
    : null;
}

/**
 * TASK-950 (D-3) — the agent's FROZEN user-identity binding, or `null` when it declares none.
 *
 * Read structurally for the same reason {@link boundContextPayloadSchema} is: the key is landed
 * on `AgentCompiledConfig.contextSchema` by another lane, and a compiled config stamped before it
 * existed simply carries nothing. Absent is "this schema names no identity field", never
 * "invalid" — the marker is additive-optional by construction.
 *
 * A MALFORMED marker (missing or empty `kindKey`/`field`) also reads as absent rather than
 * raising: the publish gate is what refuses a bad marker, and a runtime that started 500ing on
 * artifacts published before that gate would take working agents down over a field they never used.
 */
function boundUserIdentityBinding(resolved: ResolvedAgent): UserIdentityBinding | null {
  // Through `asRecord` rather than a cast, so this compiles whether or not the declared
  // `AgentCompiledConfig.contextSchema` type has learned the key yet — the compiled config is
  // JSON on the wire either way.
  const marker = asRecord(resolved.compiledConfig.contextSchema).userIdentity;
  if (marker === null || typeof marker !== 'object' || Array.isArray(marker)) return null;
  const { kindKey, field } = marker as { kindKey?: unknown; field?: unknown };
  if (typeof kindKey !== 'string' || kindKey.length === 0) return null;
  if (typeof field !== 'string' || field.length === 0) return null;
  return { kindKey, field };
}

/**
 * The identity value this invocation supplied, in EITHER shape the agent plane accepts.
 *
 * J3-5 is why there are two: a schema declaring ONE kind keyed `context` may be invoked with the
 * flat kind object (`{ consultant_id }`) or with the envelope (`{ context: { consultant_id } }`),
 * and `contextProblems` already validates both against the same schema. Reading only the envelope
 * would resolve the clinician for one of those callers and silently not for the other — the same
 * request, two different acting users. The envelope is tried first because it is the shape
 * `payloadSchemaFromDefinition` declares; the flat fallback applies ONLY under the sole-kind rule
 * and only when the marker names that kind, so no other schema's top-level key space is guessed at.
 */
function identityValueOf(resolved: ResolvedAgent, context: unknown, binding: UserIdentityBinding): string | undefined {
  const envelopeValue = extractUserIdentityValue(asRecord(context), binding);
  if (envelopeValue !== undefined) return envelopeValue;

  const payloadSchema = boundContextPayloadSchema(resolved);
  if (binding.kindKey !== CONTEXT_NAMESPACE_ROOT || soleContextKindSchema(payloadSchema) === null) return undefined;
  const value = asRecord(unwrapSingleKindContextPayload(payloadSchema, context))[binding.field];
  return typeof value === 'string' ? value : undefined;
}

/**
 * TASK-930 §2.3 — `apps/nlp`'s wire entities in the AGENT's output vocabulary.
 *
 * The wire shape is `apps/nlp`'s `Entity` (`schemas/common.py`): `entity_type` / `confidence` /
 * `position.{start,end}`, plus enrichment fields (`umls_cui`, `icd_code`, `assertion`) that
 * belong to the clinical NER plane and are deliberately NOT re-exported here — the agent's
 * declared schema closes `additionalProperties`, so anything it does not name would be a
 * violation of the contract this agent published.
 *
 * A span with no resolvable OFFSETS is DROPPED rather than emitted with substituted ones: the
 * output schema requires `start`/`end` because a span the caller cannot locate in its own text
 * is not a finding, and a fabricated offset would highlight the wrong words in a clinical note.
 */
function mapNerEntities(data: unknown): AgentNerEntity[] {
  const raw = asRecord(data).entities;
  if (!Array.isArray(raw)) return [];
  const entities: AgentNerEntity[] = [];
  for (const item of raw) {
    const entity = asRecord(item);
    const position = asRecord(entity.position);
    const start = position.start;
    const end = position.end;
    if (typeof start !== 'number' || typeof end !== 'number') continue;
    entities.push({
      text: typeof entity.text === 'string' ? entity.text : '',
      label: typeof entity.entity_type === 'string' ? entity.entity_type : 'UNKNOWN',
      start,
      end,
      ...(typeof entity.confidence === 'number' ? { score: entity.confidence } : {}),
    });
  }
  return entities;
}

/**
 * TASK-930 §5 — the ONE `response_format` decision, in precedence order.
 *
 * An explicit `parameters.responseFormat` is the author's hyper-parameter and always wins,
 * including when it says "plain text". Only when the author expressed no opinion does the
 * agent's DECLARED `outputSchema` become the engine constraint — which is the whole point of
 * §5: the column stops being a promise the runtime never kept.
 *
 * `outputSchemaResponseFormat` (the shared contract rule, also applied by the harness and the
 * realtime lane) already returns `undefined` when `responseFormat` is set, so the two branches
 * cannot both fire; the explicit check is kept because `responseFormatOf` legitimately answers
 * `{}` for a malformed `json_schema` pair, and that silence must not be filled by the schema.
 */
function agentResponseFormat(slug: string, outputSchema: unknown, parameters: Record<string, unknown>): Record<string, unknown> {
  const explicit = responseFormatOf(parameters);
  if (Object.keys(explicit).length > 0) return explicit;
  if (parameters.responseFormat !== undefined) return {};
  const enforced = outputSchemaResponseFormat(slug, outputSchema, parameters);
  return enforced ? { response_format: enforced } : {};
}

function responseFormatOf(parameters: Record<string, unknown>): Record<string, unknown> {
  const format = parameters.responseFormat;
  if (format === 'json') return { response_format: { type: 'json' } };
  if (format === 'json_schema' && parameters.responseSchema && typeof parameters.responseSchema === 'object') {
    return { response_format: { type: 'json_schema', json_schema: parameters.responseSchema, strict: true } };
  }
  return {};
}
