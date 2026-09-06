import { BadRequestException, Injectable, Logger, Optional } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import type { Readable } from 'node:stream';
import { AsrPipelineRepository, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { jsonSchemaValueProblems } from '@arcaai/json-schema-subset';
import { PromptTemplateSyntaxError, PromptVariableUnresolvedError, renderTemplate } from '@arcaai/workflow-contract';
import type { ResolvedAgent } from '@arcaai/types';
import { TENANTLESS, internalServiceHeaders, resolveInternalAccessToken } from '../../common';
import { SecretsService } from '../baseServices/_meta/secrets';
import { TextRequestEnrichmentService } from '../text-request/text-request-enrichment.service';
import type { GuardrailDisposition } from '../usageLedger/usage-attributes';
import { soleContextKindSchema, unwrapSingleKindContextPayload } from '../consultation-context-schema/context-schema-definition';
import { buildAgentPromptScope } from './agent-prompt-scope';

export interface AgentTextInvocationResult {
  text: string;
  provider: string | null;
  model: string | null;
  usage: { promptTokens: number | null; completionTokens: number | null } | null;
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

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    private readonly textRequestEnrichment: TextRequestEnrichmentService,
    @Optional() private readonly secretsService?: SecretsService,
    @Optional() private readonly asrPipelineRepository?: AsrPipelineRepository,
  ) {
    // Bootstrap TRANSPORT address (rule 00): the only sanctioned env default.
    this.textServiceUrl = this.configService.get<string>('TEXT_URL') ?? 'http://localhost:8862';
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
  async invokeText(resolved: ResolvedAgent, tenantId: string, input: Record<string, unknown>, mode: 'stream'): Promise<{ stream: Readable }>;
  async invokeText(
    resolved: ResolvedAgent,
    tenantId: string,
    input: Record<string, unknown>,
    mode: 'blocking' | 'stream',
  ): Promise<AgentTextInvocationResult | { stream: Readable }> {
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
    const systemPrompt = this.renderScoped(resolved.slug, () => {
      const scope = buildAgentPromptScope({
        variables,
        input,
        trigger: this.contextScopeFor(resolved, input.context),
        templateRef: `agent:${resolved.slug}`,
      });
      return compiled.resolvedPrompt ? renderTemplate(compiled.resolvedPrompt.content, scope, { templateRef: `agent:${resolved.slug}` }) : undefined;
    });

    const body: Record<string, unknown> = {
      prompt: String(input.text ?? ''),
      ...(systemPrompt ? { system_prompt: systemPrompt } : {}),
      ...(compiled.model.provider ? { provider: compiled.model.provider } : {}),
      model: compiled.model.slug,
      ...(typeof generation.temperature === 'number' ? { temperature: generation.temperature } : {}),
      ...(typeof generation.maxTokens === 'number' ? { max_tokens: generation.maxTokens } : {}),
      ...(typeof generation.topP === 'number' ? { top_p: generation.topP } : {}),
      ...responseFormatOf(parameters),
      stream: mode === 'stream',
      context: { agentSlug: resolved.slug, agentVersionId: resolved.agentVersionId },
    };
    // The same enrichment order every sanctioned `/api/v1/generate` caller uses: hyper-parameter
    // profile first, then the tenant → SYSTEM credential fold (`provider_overrides`, funding).
    await this.textRequestEnrichment.applyTextRuntimeProfile(body as { provider?: string; model?: string });
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
      return { stream: response.data as Readable };
    }

    const response = await this.httpService.axiosRef.post(`${this.textServiceUrl}/api/v1/generate`, body, { headers });
    const data = (response.data ?? {}) as {
      content?: string;
      summary?: string;
      provider?: string;
      model?: string;
      usage?: { prompt_tokens?: number; completion_tokens?: number };
    };
    return {
      text: data.content ?? data.summary ?? '',
      provider: data.provider ?? compiled.model.provider ?? null,
      model: data.model ?? compiled.model.slug,
      usage: data.usage ? { promptTokens: data.usage.prompt_tokens ?? null, completionTokens: data.usage.completion_tokens ?? null } : null,
    };
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
   * Render the agent's instruction through the ONE grammar (§3.2), turning its two named
   * failures into the 400 the caller can act on.
   *
   * A 400 rather than a 500 because both are the CALLER's: an unresolved placeholder means the
   * request did not supply what the agent's prompt declares, and a syntax error means the
   * published instruction is malformed (publish reports it as `PROMPT_TEMPLATE_SYNTAX`). Either
   * way nothing is sent upstream — a half-substituted prompt, or one carrying a literal
   * `{{…}}`, is the failure mode this grammar exists to end.
   */
  private renderScoped(agentSlug: string, work: () => string | undefined): string | undefined {
    try {
      return work();
    } catch (error) {
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
      model: resolved.compiledConfig.model.slug,
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

function responseFormatOf(parameters: Record<string, unknown>): Record<string, unknown> {
  const format = parameters.responseFormat;
  if (format === 'json') return { response_format: { type: 'json' } };
  if (format === 'json_schema' && parameters.responseSchema && typeof parameters.responseSchema === 'object') {
    return { response_format: { type: 'json_schema', json_schema: parameters.responseSchema, strict: true } };
  }
  return {};
}
