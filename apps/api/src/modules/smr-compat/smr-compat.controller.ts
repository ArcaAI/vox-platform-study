import {
  Authorize,
  HarnessPolicyService,
  IActiveUserContext,
  IConfigService,
  IDnaWritingStyleService,
  IProviderConnectionService,
  RequiredScopes,
  SecretsService,
  assertProviderAvailable,
} from '@arcaai/applications';
import { HttpService } from '@nestjs/axios';
import { Body, Controller, HttpException, HttpStatus, Inject, Logger, Optional, Post, Req, Res, UnauthorizedException } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AxiosError } from 'axios';
import type { Response } from 'express';
import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { ClsService } from 'nestjs-cls';
import type { RequestWithAuth } from '../../types/request-with-auth';
import { PreSummaryRequest } from './dto/pre-summary.request';
import type { PreSummaryResponse, SummaryResponse, TokenUsage } from './dto/summary.response';
import { SyncSummaryRequest } from './dto/sync-summary.request';
import { SmrCompatTemplateService } from './smr-compat-template.service';
import { buildPreSummaryPrompt, buildSummaryPrompt } from './summary-prompt.builder';
import { mapGenerateToV1PreSummary, mapGenerateToV1Summary } from './summary-response.mapper';
import { ENHANCED_SUMMARY_SCHEMA, SIMPLIFIED_SUMMARY_SCHEMA } from './summary-schemas';

// Codes that can occur ONLY while establishing the connection, i.e. before any
// request bytes reached SMR. `/generate` is non-idempotent (billable
// generation), so a retry is safe only when the request provably never left
// the gateway — mirrors `SmrProxyController.CONNECT_PHASE_CODES`.
const CONNECT_PHASE_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND']);
// v1 `/presummary` defaults (`routes.py`: `request.temperature or 0.2`,
// `request.max_tokens or 800`). The 800-token ceiling is what enforces the
// prompt's "CRISP" instruction — raising it is what made v2 verbose (TASK-634
// D-10). Caller-supplied values still win, exactly as in v1.
const PRE_SUMMARY_DEFAULT_TEMPERATURE = 0.2;
const PRE_SUMMARY_DEFAULT_MAX_TOKENS = 800;

// SSE keepalive cadence for the held-open compat streams — mirrors
// `SmrProxyController.SSE_HEARTBEAT_INTERVAL_MS`.
const SSE_HEARTBEAT_INTERVAL_MS = 15_000;
// Upper bound for the held-open task-stream GET (matches the proxy).
const STREAM_READ_TIMEOUT_MS = 300_000;

// v1 label constant (`summary_service.py:381`) — cosmetic display value.
const SUMMARY_PARSING_METHOD_LABEL = 'json_schema';

/** Session-metadata keys v1 reads for the department (`prompt_selector.py:166`). */
const DEPARTMENT_METADATA_KEYS = ['department', 'department_name', 'current_department', 'dept', 'department_id'] as const;
/** Session-metadata keys v1 reads for the visit type (`prompt_selector.py:170`). */
const VISIT_TYPE_METADATA_KEYS = ['visit_type', 'visit', 'encounter', 'encounter_type'] as const;

/** The department/visit type resolved from the request + session (un-normalized). */
export interface ResolvedDepartmentVisit {
  department?: string;
  visitType?: string;
}

function firstNonEmptyMetadata(metadata: Record<string, unknown>, keys: readonly string[]): string | undefined {
  for (const key of keys) {
    const value = metadata[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
    if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  }
  return undefined;
}

/**
 * Resolve the effective department + visit type for prompt selection, mirroring
 * v1 `extract_department_and_visit_type` (`prompt_selector.py:157-176`) and the
 * frozen TASK-560 wire contract:
 *   department  = body.department (non-empty) ELSE session_metadata[dept aliases]
 *   visit_type  = body.visit_type (non-empty) ELSE session_metadata[visit aliases]
 *                 ELSE session_data.session_type
 * (Normalization to the 7 v1 departments / new_referral|followup happens later,
 * in `selectDeptTemplate`.)
 */
export function resolveDepartmentVisit(
  body: { department?: string; visit_type?: string },
  sessionData: { session_metadata?: Record<string, unknown>; session_type?: string },
): ResolvedDepartmentVisit {
  const metadata = sessionData.session_metadata ?? {};

  const department =
    typeof body.department === 'string' && body.department.trim()
      ? body.department.trim()
      : firstNonEmptyMetadata(metadata, DEPARTMENT_METADATA_KEYS);

  const visitType =
    typeof body.visit_type === 'string' && body.visit_type.trim()
      ? body.visit_type.trim()
      : (firstNonEmptyMetadata(metadata, VISIT_TYPE_METADATA_KEYS) ??
        (typeof sessionData.session_type === 'string' && sessionData.session_type.trim() ? sessionData.session_type.trim() : undefined));

  return { department, visitType };
}

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
  response_format?: SmrResponseFormat;
  stream?: boolean;
  // TASK-602 follow-up: per-request BYOK credential for a cloud provider, keyed
  // by the request's provider name. SMR no longer reads cloud creds from env, so
  // an azure/openai/anthropic selection (primary OR fallback) must carry its key
  // here or SMR fails closed with ProviderCredentialsError (503).
  provider_overrides?: Record<string, Record<string, unknown>>;
}

/** One decoded SMR SSE frame (`event: <type>` + JSON `data`). */
interface SmrStreamFrame {
  type?: string;
  content?: string;
  data?: unknown;
}

/**
 * Terminal state of a single `pumpTaskStream` run.
 * - `completed`         — a `done` frame resolved a result to the client.
 * - `error_pre_content` — the task stream failed BEFORE any `delta` reached the
 *   client; `res` is left open so the caller may restart on a fallback provider.
 * - `error_final`       — a terminal `error` was written to the client; `res` is ended.
 */
type PumpOutcome = 'completed' | 'error_pre_content' | 'error_final';

// The subset of SMR `GenerateResponse` (apps/smr models/responses.py) this shim
// reads. Provider internals are intentionally NOT surfaced to the client.
interface SmrGenerateResponse {
  task_id?: string;
  content: string;
  latency_ms?: number;
  finish_reason?: string;
  usage?: TokenUsage;
}

/**
 * v1-compatible SMR summary gateway shims (TASK-562).
 *
 * Reproduces the v1 endpoints `POST /api/smr/api/v1/summary/sync` and
 * `POST /api/smr/api/v1/presummary` as STATELESS shims over SMR
 * `POST /api/v1/generate`. The literal paths are produced by declaring
 * `@Controller('api/smr/api/v1')` AND excluding these two routes from the
 * `api/v1` global prefix in `main.ts`.
 *
 * No Prisma, no persistence — tenant/user come from CLS (bound by the api key
 * via `UnifiedAuthGuard`). Downstream URL resolves only through
 * `IConfigService`; the `X-Service-Token` is attached from `SecretsService`.
 */
@ApiTags('smr-compat')
@ApiBearerAuth()
@Controller('api/smr/api/v1')
export class SmrCompatController {
  private readonly logger = new Logger(SmrCompatController.name);

  constructor(
    private readonly httpService: HttpService,
    @Inject(IConfigService) private readonly configService: IConfigService,
    private readonly clsService: ClsService<IActiveUserContext>,
    private readonly harnessPolicyService: HarnessPolicyService,
    // TASK-592: resolves the tenant's real Department → governed instruction template.
    private readonly templateService: SmrCompatTemplateService,
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
    // TASK-599: resolves the requesting doctor's decrypted DNA writing-style
    // (gate-checked). @Optional so the shim degrades to department+visit-type
    // steering if the DNA module is ever absent — DNA is additive, never required.
    @Optional() @Inject(IDnaWritingStyleService) private readonly dnaWritingStyleService?: IDnaWritingStyleService,
    // TASK-600: resolves per-tenant Sarvam BYOK from the unified provider plane
    // for the pre-summarization transcript translation (now served by SMR).
    // @Optional so the shim degrades gracefully (platform key) when absent.
    @Optional() @Inject(IProviderConnectionService) private readonly providerConnectionService?: IProviderConnectionService,
  ) {}

  /**
   * TASK-600 — when `translate_to_english` is set, return a copy of `body` whose
   * transcript segments are translated to English via SMR's `/api/v1/translate`
   * (the Sarvam translate capability). Per-tenant Sarvam BYOK is resolved from the
   * unified provider plane (`resolveTenantCloudOverrides('stt','sarvam')` — one
   * Sarvam subscription key serves every capability), and forwarded to SMR as a
   * `provider_overrides` entry; absent ⇒ SMR uses its platform `SMR_SARVAM_API_KEY`.
   * FAIL-OPEN: any error (SMR down, Sarvam failure, unexpected shape) logs a
   * warning and returns the ORIGINAL body so the summary is still produced. Flag
   * off/absent ⇒ no SMR translate call.
   */
  private async maybeTranslateBody(body: SyncSummaryRequest, tenantId: string): Promise<SyncSummaryRequest> {
    if (body.translate_to_english !== true) return body;
    const segments = body.session_data?.conversation_segments ?? [];
    const texts = segments.map((s) => s.text ?? '');
    if (texts.every((t) => !t.trim())) return body;

    try {
      // Sarvam is BYOK-ONLY — never an env credential. The key comes from the
      // unified provider plane: the tenant admin's own Sarvam credential, else the
      // global admin's platform (SYSTEM-tenant) credential. One Sarvam
      // subscription key covers STT/TTS/translate, so the existing 'stt' Sarvam
      // BYO row is reused. Only the 'sarvam' entry is forwarded (minimal exposure);
      // if neither tier has one, no credential is sent and SMR fails → fail-open.
      const sarvamOverride = await this.resolveSarvamByok(tenantId);
      const providerOverrides = sarvamOverride ? { sarvam: sarvamOverride } : undefined;

      const base = this.getSmrBaseUrl();
      const url = `${base.replace(/\/+$/, '')}/api/v1/translate`;
      const response = await this.httpService.axiosRef.post(
        url,
        { texts, source_language: 'auto', target_language: 'en-IN', provider: 'sarvam', provider_overrides: providerOverrides },
        { headers: this.getForwardHeaders(), timeout: 60_000 },
      );
      const translations = (response.data as { translations?: unknown })?.translations;
      if (!Array.isArray(translations) || translations.length !== segments.length) {
        throw new Error('SMR /api/v1/translate returned an unexpected shape');
      }
      const translatedSegments = segments.map((s, i) => ({ ...s, text: String(translations[i]) }));
      return {
        ...body,
        session_data: {
          ...body.session_data,
          conversation_segments: translatedSegments,
          // The transcript is now English, so the SUMMARY must be English too
          // (TASK-600 AC: translate_to_english ⇒ English summary). Force the
          // output-language directive to 'en'; otherwise `resolveLanguage` reads
          // the source language ('ml'/'hi') from session_metadata and the prompt
          // orders the model to write the summary back in the source language —
          // producing a non-English summary from an English transcript.
          session_metadata: { ...(body.session_data?.session_metadata ?? {}), language: 'en' },
        },
      };
    } catch (err) {
      this.logger.warn({
        message: 'Transcript translation failed; summarizing the original transcript (fail-open)',
        correlationId: this.clsService.getId(),
        error: err instanceof Error ? err.message : String(err),
      });
      return body;
    }
  }

  /**
   * TASK-600 — resolve the effective Sarvam credential (decrypted) from the
   * unified provider plane: the tenant admin's own row first, then the global
   * admin's platform (SYSTEM-tenant) credential. Sarvam is BYOK-only — there is
   * NO env fallback. Returns `undefined` when neither tier has an enabled Sarvam
   * credential (→ SMR gets no key → fail-open, no translation). One Sarvam
   * subscription key serves every capability, so the `stt`/`sarvam` connection
   * row is the source.
   *
   * TASK-643 — this used to hand-roll the tenant→SYSTEM cascade by calling the
   * resolver TWICE, and it was the only place in the codebase that reached the
   * platform tier at all. It now rides the shared cascade, so the veto, the
   * entitlement gate and the `funding` label apply here exactly as everywhere
   * else instead of being a second, divergent implementation of the same rule.
   */
  private async resolveSarvamByok(tenantId: string): Promise<Record<string, unknown> | undefined> {
    if (!this.providerConnectionService) return undefined;
    const resolved = await this.providerConnectionService.resolveTenantCloudOverrides('stt', tenantId).catch(() => undefined);
    return resolved?.overrides.sarvam as Record<string, unknown> | undefined;
  }

  /**
   * TASK-599 — the requesting doctor's decrypted DNA writing-style text, or
   * `undefined` when no `doctor_id` was supplied (D5: department + visit-type
   * only), the DNA service is unavailable, the tenant/doctor gate is off, or the
   * doctor has no style. Never throws — DNA is additive; any failure degrades to
   * "no style" so a summary is always produced.
   */
  private async resolveDnaStyleText(doctorId?: string): Promise<string | undefined> {
    const id = doctorId?.trim();
    if (!id || !this.dnaWritingStyleService) return undefined;
    try {
      return (await this.dnaWritingStyleService.getEffectiveStyleText(id)) ?? undefined;
    } catch (err) {
      this.logger.warn({
        message: 'DNA writing-style resolution failed; proceeding without style',
        correlationId: this.clsService.getId(),
        error: err instanceof Error ? err.message : String(err),
      });
      return undefined;
    }
  }

  @Post('summary/sync')
  @Authorize()
  @RequiredScopes('consultation:report:write')
  @ApiOperation({ summary: 'v1-compatible synchronous medical summary (stateless shim over SMR /generate)' })
  async summarySync(@Body() body: SyncSummaryRequest, @Req() request: RequestWithAuth, @Res() res: Response): Promise<void> {
    // Mandatory V2 Core context: resolve-or-reject tenant BEFORE any SMR call,
    // for the stream AND non-stream branch (no SYSTEM-default leak).
    const tenantId = this.requireTenantId(request);
    if (body.stream === true) {
      await this.streamSummary(res, body, tenantId, request);
      return;
    }
    const result = await this.computeSummary(body, tenantId);
    res.status(HttpStatus.OK).json(result);
  }

  /**
   * Assemble the summary `SmrGenerateRequest` and a `buildResponse` that maps an
   * LLM `content` string into the v1 `SummaryResponse` for whichever
   * provider/model actually produced it. Shared by the sync and streaming paths
   * so the terminal body is byte-identical.
   */
  private prepareSummary(
    body: SyncSummaryRequest,
    governedInstruction?: string,
    dnaStyleText?: string,
  ): {
    baseRequest: SmrGenerateRequest;
    buildResponse: (content: string, generated: Partial<SmrGenerateResponse>, req: SmrGenerateRequest) => SummaryResponse;
  } {
    const sessionData = body.session_data;
    // A consultation/session is NOT required to summarize. `session_id` is an
    // optional correlation string echoed back on the response; synthesize one
    // when the caller omits it so `SummaryResponse.session_id` stays a valid id.
    const sessionId = sessionData.session_id?.trim() ? sessionData.session_id : `smr-${randomUUID()}`;
    const language = this.resolveLanguage(sessionData.session_metadata);
    // Enrichment logic (SMR_Summary_Endpoints.md §3.1): enabled when the flag is
    // set OR when pre_summary_text is present (the documented safety net).
    const includePreSummary = body.include_pre_summary_in_context === true || Boolean(sessionData.pre_summary_text?.trim());
    const useEnhanced = body.use_enhanced_format === true;

    // Item 1: effective department/visit type (top-level wins, else session
    // metadata aliases, else session_type) — feeds v1 dept×visit prompt steering.
    const { department, visitType } = resolveDepartmentVisit(body, sessionData);

    const { system, user } = buildSummaryPrompt(sessionData, {
      department,
      visitType,
      specialty: body.specialty,
      encounterType: body.encounter_type,
      language,
      includePreSummary,
      governedInstruction,
      dnaStyleText,
    });

    const baseRequest: SmrGenerateRequest = {
      system_prompt: system,
      prompt: user,
      temperature: body.temperature,
      max_tokens: body.max_tokens,
      response_format: {
        type: 'json_schema',
        json_schema: useEnhanced ? ENHANCED_SUMMARY_SCHEMA : SIMPLIFIED_SUMMARY_SCHEMA,
        strict: true,
      },
    };

    // Map an SMR `/generate` result into the v1 SummaryResponse for the
    // provider/model that actually produced it (labels reflect the fallback too).
    // `generated` carries the non-stream metadata (task_id/latency/usage); in the
    // streaming path it is empty and only the accumulated `content` is available.
    const buildResponse = (content: string, generated: Partial<SmrGenerateResponse>, req: SmrGenerateRequest): SummaryResponse =>
      mapGenerateToV1Summary(content, {
        sessionId,
        summaryId: generated.task_id,
        useEnhanced,
        latencyMs: generated.latency_ms,
        finishReason: generated.finish_reason,
        tokenUsage: generated.usage ?? null,
        temperature: body.temperature ?? null,
        maxTokens: body.max_tokens ?? null,
        language,
        specialty: body.specialty ?? null,
        encounterType: body.encounter_type ?? null,
        preSummaryText: includePreSummary ? sessionData.pre_summary_text : undefined,
        // Item 4: v1-parity display labels.
        llmProvider: req.provider ?? null,
        modelName: req.model ?? null,
        parsingMethod: SUMMARY_PARSING_METHOD_LABEL,
        rawLlmContent: content,
        createdAt: new Date(),
      });

    return { baseRequest, buildResponse };
  }

  /**
   * TASK-592: resolve the tenant's governed department instruction template for
   * this summary request, or `undefined` when no real tenant department matches
   * (→ the builder uses the static dept×visit steering). The visit type maps to
   * the resolver's `new-patient` / `revisit` prompt bucket. Never throws.
   */
  private async resolveSummaryGoverned(body: SyncSummaryRequest, tenantId: string): Promise<string | undefined> {
    const { department, visitType } = resolveDepartmentVisit(body, body.session_data);
    const promptType = this.templateService.toSummaryPromptType(visitType);
    return this.templateService.resolveGovernedInstruction(tenantId, department, promptType, {
      visitType,
      doctorId: body.doctor_id,
    });
  }

  /**
   * Non-streaming summary path — returns the v1 `SummaryResponse`. Extracted so
   * the thin `@Post` router can share it with the streaming branch and the unit
   * suite can drive it directly.
   */
  private async computeSummary(body: SyncSummaryRequest, tenantId: string): Promise<SummaryResponse> {
    // TASK-600: translate the transcript to English first when requested (fail-open).
    const workingBody = await this.maybeTranslateBody(body, tenantId);
    const governed = await this.resolveSummaryGoverned(workingBody, tenantId);
    const dnaStyleText = await this.resolveDnaStyleText(workingBody.doctor_id);
    const { baseRequest, buildResponse } = this.prepareSummary(workingBody, governed, dnaStyleText);
    await this.applySmrModelSelection(baseRequest, tenantId);

    // Primary attempt: post + parse. A parse failure is captured here too so the
    // per-tenant fallback covers unparseable content, not just transport errors.
    let primaryError: unknown;
    try {
      const generated = await this.postGenerate(baseRequest, 'Summary generation');
      return buildResponse(generated.content, generated, baseRequest);
    } catch (err) {
      primaryError = err;
    }

    // TASK-588: per-tenant SMR fallback — ONE retry against the tenant's
    // configured fallback provider/model for provider-side failures (LLM error /
    // unparseable content / non-connect upstream error). Skipped when SMR itself
    // was unreachable (a connect-phase failure — a second call cannot help), so
    // the resolver is only consulted once the failure is fallback-eligible. When
    // the tenant has no fallback configured the resolver returns `null` (fail-open)
    // and no fallback runs — the same effect as the retired env-unset path.
    if (this.isFallbackEligible(primaryError)) {
      const fallback = await this.harnessPolicyService.resolveSmrFallbackSelection(tenantId, 'finalize');
      // Skip a same-provider fallback (retrying the identical provider cannot help).
      if (fallback && fallback.provider !== baseRequest.provider) {
        const fallbackRequest: SmrGenerateRequest = { ...baseRequest, provider: fallback.provider, model: fallback.model };
        // The fallback provider differs from the primary — re-resolve its BYOK
        // credential (the spread copied the primary's, if any). TASK-602 follow-up.
        await this.attachLlmByok(fallbackRequest, tenantId);
        try {
          const generated = await this.postGenerate(fallbackRequest, 'Summary generation (tenant fallback)');
          this.logger.warn({
            message: 'Primary SMR summary generation failed; served via tenant-configured fallback',
            fallbackProvider: fallback.provider,
            correlationId: this.clsService.getId(),
          });
          return buildResponse(generated.content, generated, fallbackRequest);
        } catch (fallbackErr) {
          // Surface the ORIGINAL primary error, not the fallback's — the primary
          // failure is the one the caller's request actually hit.
          this.logger.warn({
            message: 'Tenant-configured SMR fallback also failed for summary generation',
            correlationId: this.clsService.getId(),
            fallbackError: fallbackErr instanceof Error ? fallbackErr.message : undefined,
          });
        }
      }
    }

    throw this.mapSummaryError('Summary generation', primaryError);
  }

  /**
   * Streaming summary path. Builds the same request as `computeSummary`, then
   * proxies the SMR SSE stream as v1 `delta`/`result`/`error` events. The
   * per-tenant fallback applies ONLY to a pre-stream START failure (the
   * `/generate` POST failing before any bytes) — a half-emitted stream cannot be
   * restarted, so mid-stream failures surface as a single `error` event.
   */
  private async streamSummary(res: Response, body: SyncSummaryRequest, tenantId: string, _request: RequestWithAuth): Promise<void> {
    // TASK-600: translate the transcript to English first when requested (fail-open).
    const workingBody = await this.maybeTranslateBody(body, tenantId);
    const governed = await this.resolveSummaryGoverned(workingBody, tenantId);
    const dnaStyleText = await this.resolveDnaStyleText(workingBody.doctor_id);
    const { baseRequest, buildResponse } = this.prepareSummary(workingBody, governed, dnaStyleText);
    await this.applySmrModelSelection(baseRequest, tenantId);

    await this.streamGenerate(
      res,
      baseRequest,
      'Summary generation',
      (content, req) => buildResponse(content, {}, req),
      async (primaryError, primaryRequest) => {
        if (!this.isFallbackEligible(primaryError)) return null;
        const fallback = await this.harnessPolicyService.resolveSmrFallbackSelection(tenantId, 'finalize');
        if (fallback && fallback.provider !== primaryRequest.provider) {
          this.logger.warn({
            message: 'Primary SMR summary stream start failed; retrying via tenant-configured fallback',
            fallbackProvider: fallback.provider,
            correlationId: this.clsService.getId(),
          });
          const fallbackRequest: SmrGenerateRequest = { ...primaryRequest, provider: fallback.provider, model: fallback.model };
          await this.attachLlmByok(fallbackRequest, tenantId); // TASK-602 follow-up: fallback provider's BYOK
          return fallbackRequest;
        }
        return null;
      },
    );
  }

  /**
   * Fallback is eligible for provider-side failures: an upstream RESPONSE error
   * (SMR answered with an error — the LLM/provider failed) OR a parse/mapping
   * failure (unparseable content). It is NOT eligible when SMR itself was
   * unreachable (a connect-phase transport error with no response) — retrying a
   * different provider through the same unreachable gateway cannot help.
   */
  private isFallbackEligible(err: unknown): boolean {
    const axiosError = err as AxiosError;
    if (axiosError?.response !== undefined) return true; // SMR responded with an error
    if (typeof axiosError?.code === 'string') return false; // connect-phase / unreachable SMR
    return true; // parse/mapping failure
  }

  /** Route a summary failure to the right v1 error shape (transport vs parse). */
  private mapSummaryError(label: string, err: unknown): HttpException {
    const axiosError = err as AxiosError;
    if (axiosError?.response !== undefined || typeof axiosError?.code === 'string') {
      return this.buildUpstreamFailure(label, err);
    }
    return this.buildGenerationFailure(label, err);
  }

  @Post('presummary')
  @Authorize()
  @RequiredScopes('consultation:report:write')
  @ApiOperation({ summary: 'v1-compatible department-aware pre-summary (stateless shim over SMR /generate)' })
  async presummary(@Body() body: PreSummaryRequest, @Req() request: RequestWithAuth, @Res() res: Response): Promise<void> {
    // Mandatory V2 Core context: resolve-or-reject tenant BEFORE any SMR call.
    const tenantId = this.requireTenantId(request);
    if (body.stream === true) {
      await this.streamPreSummary(res, body, tenantId);
      return;
    }
    const result = await this.computePreSummary(body, tenantId);
    res.status(HttpStatus.OK).json(result);
  }

  /** Build the pre-summary `SmrGenerateRequest` (shared by sync + streaming). */
  private buildPreSummaryRequest(body: PreSummaryRequest, governedInstruction?: string, dnaStyleText?: string): SmrGenerateRequest {
    const { system, user } = buildPreSummaryPrompt(body, { governedInstruction, dnaStyleText });
    return {
      system_prompt: system,
      prompt: user,
      temperature: body.temperature ?? PRE_SUMMARY_DEFAULT_TEMPERATURE,
      max_tokens: body.max_tokens ?? PRE_SUMMARY_DEFAULT_MAX_TOKENS,
    };
  }

  /**
   * Non-streaming pre-summary path — returns the v1 `PreSummaryResponse`.
   * TASK-592: department-aware (governed template) AND provider-fallback parity
   * with the summary path — ONE retry against the tenant's configured fallback
   * for a provider-side failure (LLM error / unparseable content), fail-open when
   * no fallback is configured. `mapSummaryError` routes transport vs parse to the
   * same v1 error shapes the summary path uses.
   */
  private async computePreSummary(body: PreSummaryRequest, tenantId: string): Promise<PreSummaryResponse> {
    const governed = await this.templateService.resolveGovernedInstruction(tenantId, body.current_department, 'pre-summary', {
      visitType: body.visit_type,
      doctorId: body.doctor_id,
    });
    const dnaStyleText = await this.resolveDnaStyleText(body.doctor_id);
    const smrRequest = this.buildPreSummaryRequest(body, governed, dnaStyleText);
    await this.applySmrModelSelection(smrRequest, tenantId);

    let primaryError: unknown;
    try {
      const generated = await this.postGenerate(smrRequest, 'Pre-summary generation');
      return mapGenerateToV1PreSummary(generated.content, new Date());
    } catch (err) {
      primaryError = err;
    }

    if (this.isFallbackEligible(primaryError)) {
      const fallback = await this.harnessPolicyService.resolveSmrFallbackSelection(tenantId, 'finalize');
      if (fallback && fallback.provider !== smrRequest.provider) {
        const fallbackRequest: SmrGenerateRequest = { ...smrRequest, provider: fallback.provider, model: fallback.model };
        await this.attachLlmByok(fallbackRequest, tenantId); // TASK-602 follow-up: fallback provider's BYOK
        try {
          const generated = await this.postGenerate(fallbackRequest, 'Pre-summary generation (tenant fallback)');
          this.logger.warn({
            message: 'Primary SMR pre-summary generation failed; served via tenant-configured fallback',
            fallbackProvider: fallback.provider,
            correlationId: this.clsService.getId(),
          });
          return mapGenerateToV1PreSummary(generated.content, new Date());
        } catch (fallbackErr) {
          this.logger.warn({
            message: 'Tenant-configured SMR fallback also failed for pre-summary generation',
            correlationId: this.clsService.getId(),
            fallbackError: fallbackErr instanceof Error ? fallbackErr.message : undefined,
          });
        }
      }
    }

    throw this.mapSummaryError('Pre-summary generation', primaryError);
  }

  /**
   * Streaming pre-summary path. TASK-592: department-aware (governed template)
   * AND, at parity with the summary stream, a pre-stream START failure may retry
   * ONCE on the tenant's configured fallback provider; a half-emitted stream
   * cannot restart, so mid-stream failures surface as a single `error` event.
   */
  private async streamPreSummary(res: Response, body: PreSummaryRequest, tenantId: string): Promise<void> {
    const governed = await this.templateService.resolveGovernedInstruction(tenantId, body.current_department, 'pre-summary', {
      visitType: body.visit_type,
      doctorId: body.doctor_id,
    });
    const dnaStyleText = await this.resolveDnaStyleText(body.doctor_id);
    const smrRequest = this.buildPreSummaryRequest(body, governed, dnaStyleText);
    await this.applySmrModelSelection(smrRequest, tenantId);
    await this.streamGenerate(
      res,
      smrRequest,
      'Pre-summary generation',
      (content) => mapGenerateToV1PreSummary(content, new Date()),
      async (primaryError, primaryRequest) => {
        if (!this.isFallbackEligible(primaryError)) return null;
        const fallback = await this.harnessPolicyService.resolveSmrFallbackSelection(tenantId, 'finalize');
        if (fallback && fallback.provider !== primaryRequest.provider) {
          this.logger.warn({
            message: 'Primary SMR pre-summary stream start failed; retrying via tenant-configured fallback',
            fallbackProvider: fallback.provider,
            correlationId: this.clsService.getId(),
          });
          const fallbackRequest: SmrGenerateRequest = { ...primaryRequest, provider: fallback.provider, model: fallback.model };
          await this.attachLlmByok(fallbackRequest, tenantId); // TASK-602 follow-up: fallback provider's BYOK
          return fallbackRequest;
        }
        return null;
      },
    );
  }

  /** `session_metadata.language` ("en"/"ml") drives output language; default "en". */
  private resolveLanguage(metadata?: Record<string, unknown>): string {
    const language = metadata?.language;
    return typeof language === 'string' && language.trim() ? language.trim() : 'en';
  }

  private async applySmrModelSelection(request: SmrGenerateRequest, tenantId: string): Promise<void> {
    const selection = await this.harnessPolicyService.resolveSmrSelection(tenantId);
    request.provider = selection.provider;
    request.model = selection.model;
    await this.attachLlmByok(request, tenantId);
  }

  /**
   * TASK-602 follow-up: inject the tenant's LLM cloud BYOK credential for
   * `request.provider`. Mirrors `SmrProxyController` — SMR no longer holds env
   * credentials, so a cloud provider (azure/openai/anthropic) selected as
   * PRIMARY or FALLBACK must receive its key/endpoint as a per-request
   * `provider_overrides` entry, or SMR fails closed with ProviderCredentialsError
   * (503). Local engines (lm-studio/ollama) resolve to no override and are
   * unaffected. `azure-openai` de-aliases to the `azure` connection key
   * (`resolveSmrSelection`/`resolveSmrFallbackSelection` map azure→azure-openai
   * for SMR's registry; the connection plane is keyed by `azure`). The override
   * is keyed by `request.provider` so SMR's adapter (`provider_overrides[provider]`)
   * finds it. Fail-open: a resolver error leaves the request unchanged (SMR then
   * decides — a cloud provider will 503, a local one proceeds).
   */
  private async attachLlmByok(request: SmrGenerateRequest, tenantId: string): Promise<void> {
    if (!this.providerConnectionService || !request.provider) return;
    const connKey = request.provider === 'azure-openai' ? 'azure' : request.provider;
    const resolved = await this.providerConnectionService.resolveTenantCloudOverrides('llm', tenantId).catch(() => undefined);
    const entry = resolved?.overrides[connKey] as Record<string, unknown> | undefined;
    if (entry) {
      request.provider_overrides = { [request.provider]: entry };
      return;
    }
    // TASK-643 — a SUPPRESSED platform tier (tenant veto → 409, no
    // entitlement → 403) is reported instead of degrading to SMR's
    // unattributable 503. Nothing suppressed ⇒ returns void and the fail-open
    // behaviour above is unchanged.
    if (resolved) assertProviderAvailable(resolved, 'llm', connKey);
  }

  /**
   * Resolve the mandatory V2 Core tenant context: CLS-bound tenant → the
   * authenticated API key's tenant → the authenticated JWT user's own tenant.
   * The last fallback matters on these compat routes specifically: they are
   * EXCLUDED from the `api/v1` global prefix, so the JWT strategy's CLS
   * population (the "single source of truth" that normally sets CLS `tenantId`
   * for a Bearer caller) is not wired for them — the working-tenant elevation in
   * `ContextInterceptor` is likewise a no-op here. `request.user` / `request.apiKey`,
   * however, are set DIRECTLY on the Express request by the auth pipeline on every
   * route, so we read the tenant off the request — exactly as the `apiKey` branch
   * already does. Rejects with `401 Tenant context is required` when none is
   * present — no SYSTEM-default leak (§9.3 M4); a global-admin's EMPTY tenant
   * still trips it (they must act through a tenant-scoped credential).
   * Defense-in-depth: a correctly tenant-scoped key or JWT never trips it.
   */
  private requireTenantId(authRequest?: RequestWithAuth): string {
    const tenantId = this.clsService.get('tenantId') ?? authRequest?.apiKey?.tenantId ?? authRequest?.user?.tenantId;
    if (!tenantId) {
      throw new UnauthorizedException('Tenant context is required');
    }
    return tenantId;
  }

  private getSmrBaseUrl(): string {
    // Downstream URL only via the typed accessor — a direct
    // `process.env.SMR_URL` read is banned by `no-direct-downstream-url-env`.
    return this.configService.getConfigValue('SMR_URL');
  }

  private getForwardHeaders(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' };
    // Fail-open on a cache miss (no header), matching SmrProxyController.
    const serviceToken = this.secretsService?.getSecretSync('SMR_SERVICE_TOKEN');
    if (serviceToken) {
      headers['X-Service-Token'] = serviceToken;
    }
    return headers;
  }

  private isConnectPhaseFailure(err: unknown): boolean {
    const axiosError = err as AxiosError;
    if (axiosError?.response) return false; // upstream responded → request was delivered
    const code = axiosError?.code;
    return typeof code === 'string' && CONNECT_PHASE_CODES.has(code);
  }

  /**
   * POST to SMR `/api/v1/generate`, retrying ONLY on connect-phase failures
   * (the request provably never reached SMR — safe for the non-idempotent
   * billable call). Throws the RAW transport error on exhaustion so callers can
   * classify it (fallback eligibility / error-shape mapping).
   */
  private async postGenerate(request: SmrGenerateRequest, label: string): Promise<SmrGenerateResponse> {
    const data = await this.postGenerateRaw(request, label);
    return data as SmrGenerateResponse;
  }

  /**
   * POST to SMR `/api/v1/generate` with `stream:true`, returning the accepted
   * `task_id`. Shares the connect-phase retry with the non-stream path; throws
   * the RAW transport error on exhaustion (so the streaming START can classify it
   * for the per-tenant fallback).
   */
  private async postGenerateStream(request: SmrGenerateRequest, label: string): Promise<string> {
    const data = (await this.postGenerateRaw({ ...request, stream: true }, label)) as { task_id?: string };
    const taskId = data?.task_id;
    if (!taskId) {
      throw new Error('SMR did not return a task_id for the streaming request');
    }
    return taskId;
  }

  /**
   * POST `/api/v1/generate`, retrying ONLY on connect-phase failures (the request
   * provably never reached SMR — safe for the non-idempotent billable call).
   * Returns the raw response body; throws the RAW transport error on exhaustion.
   */
  private async postGenerateRaw(request: SmrGenerateRequest, label: string): Promise<unknown> {
    const base = this.getSmrBaseUrl();
    const maxRetries = 2;

    let lastErr: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await this.httpService.axiosRef.post(`${base}/api/v1/generate`, request, {
          headers: this.getForwardHeaders(),
          timeout: 120_000,
        });
        return response.data;
      } catch (err) {
        lastErr = err;
        if (attempt < maxRetries && this.isConnectPhaseFailure(err)) {
          const delayMs = Math.min(1000 * Math.pow(2, attempt), 4000);
          this.logger.warn({
            message: `Retrying ${label} (connect-phase failure)`,
            attempt: attempt + 1,
            maxRetries,
            delayMs,
          });
          await new Promise((r) => setTimeout(r, delayMs));
          continue;
        }
        break;
      }
    }

    throw lastErr;
  }

  // ── SSE streaming (opt-in `stream:true`) ────────────────────────────────────

  /**
   * Proxy an SMR `/generate` stream to the client as v1 SSE. Sets the SSE
   * headers, opens the generation (with an optional pre-stream START fallback),
   * then re-emits SMR `chunk` frames as `event: delta` and, on `done`, the
   * fully-mapped v1 body as `event: result`. Any failure surfaces as a single
   * PHI-redacted `event: error`. Mirrors `SmrProxyController.streamTaskEvents`
   * (heartbeat + disconnect cleanup) minus the native ticket — the compat POST
   * already authenticated via `x-api-key`.
   */
  private async streamGenerate(
    res: Response,
    smrRequest: SmrGenerateRequest,
    label: string,
    buildResult: (content: string, req: SmrGenerateRequest) => object,
    resolveStartFallback?: (primaryError: unknown, primaryRequest: SmrGenerateRequest) => Promise<SmrGenerateRequest | null>,
  ): Promise<void> {
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.setHeader('X-Accel-Buffering', 'no');
    res.flushHeaders();

    const heartbeatTimer = setInterval(() => {
      if (!res.writableEnded) res.write(':keepalive\n\n');
    }, SSE_HEARTBEAT_INTERVAL_MS);

    // START phase: POST /generate (stream:true). A pre-stream failure may retry
    // once on the tenant fallback (summary only); an exhausted START → error.
    let taskId: string | undefined;
    let startedRequest = smrRequest;
    let usedFallback = false;
    try {
      taskId = await this.postGenerateStream(smrRequest, label);
    } catch (primaryError) {
      const fallbackRequest = resolveStartFallback ? await resolveStartFallback(primaryError, smrRequest) : null;
      if (fallbackRequest) {
        try {
          taskId = await this.postGenerateStream(fallbackRequest, `${label} (tenant fallback)`);
          startedRequest = fallbackRequest;
          usedFallback = true;
        } catch {
          // fall through to the error emit below
        }
      }
      if (taskId === undefined) {
        this.logStreamFailure(label, primaryError);
        this.writeSse(res, 'error', { detail: `${label} failed: upstream error` });
        this.endStream(res, heartbeatTimer);
        return;
      }
    }

    // PUMP phase. SMR accepts a streaming `/generate` with 202 BEFORE the provider
    // runs, so a down PRIMARY (e.g. LM Studio) surfaces as an SMR `error` frame
    // AFTER the 202 — the START-phase fallback above never sees it. When that
    // error (or an empty stream) arrives with NOTHING yet streamed to the client,
    // the stream is safely restartable: retry ONCE on the tenant fallback, at
    // parity with the non-stream path. Retry is disabled once we are already on a
    // fallback provider or none is configured.
    const allowRetry = !!resolveStartFallback && !usedFallback;
    let outcome = await this.pumpTaskStream(res, taskId, label, (content) => buildResult(content, startedRequest), heartbeatTimer, allowRetry);
    if (outcome === 'error_pre_content') {
      // The primary stream was ACCEPTED (202) but the provider failed before any
      // content — e.g. LM Studio is down. `resolveStartFallback` (which logs the
      // retry and re-attaches the fallback provider's BYOK) restarts the stream
      // once on the tenant fallback; nothing has reached the client, so this is
      // clean. A synthetic error drives its eligibility check down the
      // parse/mapping branch (a provider-side failure, not an unreachable SMR).
      const fallbackRequest = resolveStartFallback ? await resolveStartFallback(new Error(`${label} stream produced no content`), smrRequest) : null;
      let retried = false;
      if (fallbackRequest && fallbackRequest.provider !== smrRequest.provider) {
        try {
          const fallbackTaskId = await this.postGenerateStream(fallbackRequest, `${label} (tenant fallback)`);
          startedRequest = fallbackRequest;
          outcome = await this.pumpTaskStream(res, fallbackTaskId, label, (content) => buildResult(content, startedRequest), heartbeatTimer, false);
          retried = true;
        } catch {
          // fall through to finalize the error below
        }
      }
      if (!retried && !res.writableEnded) {
        this.writeSse(res, 'error', { detail: `${label} failed: upstream error` });
        this.endStream(res, heartbeatTimer);
      }
    }
  }

  /**
   * Open the held-open SMR task stream and re-emit its frames to the client.
   * `chunk` → `event: delta { text }` (accumulating); `done` → `event: result`
   * carrying `buildResult(accumulated)`; `error`/parse/mapping failure →
   * `event: error` (PHI-redacted — never echo upstream content).
   */
  private async pumpTaskStream(
    res: Response,
    taskId: string,
    label: string,
    buildResult: (content: string) => object,
    heartbeatTimer: ReturnType<typeof setInterval>,
    allowPreContentRetry: boolean,
  ): Promise<PumpOutcome> {
    const base = this.getSmrBaseUrl();

    let upstream;
    try {
      upstream = await this.httpService.axiosRef.get(`${base}/api/v1/tasks/${taskId}/stream`, {
        headers: { ...this.getForwardHeaders(), Accept: 'text/event-stream' },
        responseType: 'stream',
        timeout: STREAM_READ_TIMEOUT_MS,
      });
    } catch (err) {
      // Opening the task stream failed before any content reached the client.
      if (allowPreContentRetry) return 'error_pre_content';
      this.logStreamFailure(label, err);
      this.writeSse(res, 'error', { detail: `${label} failed: upstream error` });
      this.endStream(res, heartbeatTimer);
      return 'error_final';
    }

    const stream = upstream.data as Readable;
    return await new Promise<PumpOutcome>((resolve) => {
      let buffer = '';
      let accumulated = '';
      let finished = false;

      const finalizeError = (detail: string): void => {
        if (finished) return;
        finished = true;
        this.writeSse(res, 'error', { detail });
        stream.destroy();
        this.endStream(res, heartbeatTimer);
        resolve('error_final');
      };

      // Nothing has reached the client yet — tear down THIS upstream but leave
      // `res` (and its heartbeat) open so the caller can restart on a fallback
      // provider. No `error` event is written, so the client stream is intact.
      const preContentRetry = (): void => {
        if (finished) return;
        finished = true;
        stream.destroy();
        resolve('error_pre_content');
      };

      // A failure BEFORE any `delta` is safely restartable; once content has
      // streamed, the only honest outcome is a terminal `error`.
      const onFailure = (detail: string, err?: unknown): void => {
        if (err !== undefined) this.logStreamFailure(label, err);
        if (accumulated === '' && allowPreContentRetry) preContentRetry();
        else finalizeError(detail);
      };

      stream.on('data', (chunk: Buffer) => {
        if (finished) return;
        buffer += chunk.toString('utf8').replace(/\r\n/g, '\n');
        let idx: number;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const rawFrame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const frame = this.parseSmrFrame(rawFrame);
          if (!frame) continue;

          if (frame.type === 'chunk') {
            const text = typeof frame.content === 'string' ? frame.content : '';
            if (text) {
              accumulated += text;
              this.writeSse(res, 'delta', { text });
            }
          } else if (frame.type === 'reasoning') {
            // Reasoning-model chain-of-thought (Azure `reasoning_content`,
            // Anthropic thinking, LM Studio reasoning delta). Forwarded as its
            // OWN event so the client can display it separately. Deliberately
            // NOT added to `accumulated`: it is not part of the answer, must not
            // corrupt the result JSON, and must not gate the pre-content fallback.
            const text = typeof frame.content === 'string' ? frame.content : '';
            if (text) this.writeSse(res, 'reasoning', { text });
          } else if (frame.type === 'done') {
            finished = true;
            try {
              this.writeSse(res, 'result', buildResult(accumulated));
            } catch (err) {
              // Mapping/parse failure — redacted: the reason may echo LLM content.
              this.logger.error({
                message: `${label} failed to assemble streaming result`,
                correlationId: this.clsService.getId(),
                redacted: true,
                reason: err instanceof Error ? err.name : undefined,
              });
              this.writeSse(res, 'error', { detail: `${label} failed` });
            }
            stream.destroy();
            this.endStream(res, heartbeatTimer);
            resolve('completed');
            return;
          } else if (frame.type === 'error') {
            // SMR error frame — never forward its content (may carry PHI/prompt).
            this.logger.error({
              message: `SMR error frame during ${label} (content redacted)`,
              correlationId: this.clsService.getId(),
              redacted: true,
            });
            onFailure(`${label} failed: upstream error`);
            return;
          }
          // meta / usage frames are progress-only — ignored.
        }
      });

      // Upstream closed without a terminal `done` frame → treat as an error.
      stream.on('end', () => {
        if (finished) return;
        onFailure(`${label} failed: upstream error`);
      });

      stream.on('error', (err: Error) => {
        if (finished) return;
        onFailure(`${label} failed: upstream error`, err);
      });

      // Client disconnected — stop the heartbeat and tear down the upstream.
      res.on('close', () => {
        if (!res.writableEnded) {
          clearInterval(heartbeatTimer);
          stream.destroy();
        }
        if (!finished) {
          finished = true;
          resolve('error_final');
        }
      });
    });
  }

  /** Decode one SMR SSE frame (`event:`/`data:` lines) into a `StreamChunk`. */
  private parseSmrFrame(rawFrame: string): SmrStreamFrame | null {
    let eventName: string | undefined;
    const dataParts: string[] = [];
    for (const line of rawFrame.split('\n')) {
      if (!line || line.startsWith(':')) continue; // blank / comment (heartbeat)
      if (line.startsWith('event:')) eventName = line.slice('event:'.length).trim();
      else if (line.startsWith('data:')) dataParts.push(line.slice('data:'.length).replace(/^ /, ''));
    }
    if (dataParts.length === 0) return eventName ? { type: eventName } : null;
    try {
      const parsed = JSON.parse(dataParts.join('\n')) as SmrStreamFrame;
      return { type: parsed.type ?? eventName, content: parsed.content, data: parsed.data };
    } catch {
      return { type: eventName };
    }
  }

  /** Write one SSE event to the client (guards against a closed socket). */
  private writeSse(res: Response, event: string, data: unknown): void {
    if (res.writableEnded) return;
    res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  }

  /** Clear the heartbeat and end the response once (idempotent). */
  private endStream(res: Response, heartbeatTimer: ReturnType<typeof setInterval>): void {
    clearInterval(heartbeatTimer);
    if (!res.writableEnded) res.end();
  }

  /**
   * Log a streaming failure WITHOUT the upstream body — it can echo the assembled
   * clinical prompt / PHI. Only non-content metadata is recorded.
   */
  private logStreamFailure(label: string, err: unknown): void {
    const axiosError = err as AxiosError;
    this.logger.error({
      message: `SMR streaming failure during ${label} (body redacted — may contain PHI/prompt content)`,
      upstreamStatus: axiosError?.response?.status,
      code: axiosError?.code,
      correlationId: this.clsService.getId(),
      upstreamBodyRedacted: true,
    });
  }

  /**
   * Map an SMR transport failure to the v1 error shapes (§3.4/§4.3):
   *   - no upstream response (unreachable) → `{ error, requestId, timestamp }`;
   *   - upstream responded with an error → `{ detail: "<label> failed: ..." }`.
   * The raw upstream body is NEVER forwarded or logged — it can echo the
   * assembled clinical prompt / PHI. Only non-content metadata is recorded.
   */
  private buildUpstreamFailure(label: string, err: unknown): HttpException {
    const axiosError = err as AxiosError;
    const upstreamStatus = axiosError?.response?.status;

    if (axiosError?.response !== undefined) {
      this.logger.error({
        message: `SMR upstream error during ${label} (body redacted — may contain PHI/prompt content)`,
        upstreamStatus,
        correlationId: this.clsService.getId(),
        upstreamBodyRedacted: true,
      });
      return new HttpException({ detail: `${label} failed: upstream error` }, HttpStatus.INTERNAL_SERVER_ERROR);
    }

    this.logger.error({
      message: 'SMR service unavailable',
      label,
      code: axiosError?.code,
      correlationId: this.clsService.getId(),
    });
    return new HttpException(
      {
        error: 'SMR service unavailable',
        requestId: this.clsService.getId(),
        timestamp: new Date().toISOString(),
      },
      HttpStatus.INTERNAL_SERVER_ERROR,
    );
  }

  /** Map a parse/mapping failure to the v1 `500 { detail: "<label> failed: <reason>" }`. */
  private buildGenerationFailure(label: string, err: unknown): HttpException {
    const reason = err instanceof Error ? err.message : String(err);
    this.logger.error({ message: `${label} failed`, reason, correlationId: this.clsService.getId() });
    return new HttpException({ detail: `${label} failed: ${reason}` }, HttpStatus.INTERNAL_SERVER_ERROR);
  }
}
