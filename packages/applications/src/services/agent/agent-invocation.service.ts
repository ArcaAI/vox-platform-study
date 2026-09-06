import { BadRequestException, Injectable, Logger, Optional } from '@nestjs/common';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import type { Readable } from 'node:stream';
import { AsrPipelineRepository, SYSTEM_TENANT_ID } from '@arcaai/domains';
import { jsonSchemaValueProblems } from '@arcaai/json-schema-subset';
import type { ResolvedAgent } from '@arcaai/types';
import { TENANTLESS, internalServiceHeaders, resolveInternalAccessToken } from '../../common';
import { SecretsService } from '../baseServices/_meta/secrets';
import { TextRequestEnrichmentService } from '../text-request/text-request-enrichment.service';
import type { GuardrailDisposition } from '../usageLedger/usage-attributes';

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

/** `{{var}}` substitution — the PromptManagementService.interpolateTemplate shape, for the agent's bound variables. */
function interpolate(content: string, variables: Record<string, unknown>): string {
  return content.replace(/\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g, (match, key: string) => {
    const value = variables[key];
    return value === undefined || value === null ? match : String(value);
  });
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
    const compiled = resolved.compiledConfig;
    const parameters = asRecord(compiled.parameters);
    const generation = asRecord(parameters.generation);
    const boundVariables = asRecord(asRecord(compiled.instruction).variables);
    const variables = { ...boundVariables, ...asRecord(input.variables) };
    const systemPrompt = compiled.resolvedPrompt ? interpolate(compiled.resolvedPrompt.content, variables) : undefined;

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
    this.textRequestEnrichment.applyGuardrailDecision(body, resolved.guardrail);

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

function responseFormatOf(parameters: Record<string, unknown>): Record<string, unknown> {
  const format = parameters.responseFormat;
  if (format === 'json') return { response_format: { type: 'json' } };
  if (format === 'json_schema' && parameters.responseSchema && typeof parameters.responseSchema === 'object') {
    return { response_format: { type: 'json_schema', json_schema: parameters.responseSchema, strict: true } };
  }
  return {};
}
