import { Authorize, HarnessPolicyService, IActiveUserContext, IConfigService, SecretsService } from '@arcaai/applications';
import { HttpService } from '@nestjs/axios';
import { Body, Controller, HttpException, HttpStatus, Inject, Logger, Optional, Post, Req } from '@nestjs/common';
import { ApiBearerAuth, ApiOperation, ApiTags } from '@nestjs/swagger';
import type { AxiosError } from 'axios';
import { ClsService } from 'nestjs-cls';
import type { RequestWithAuth } from '../../types/request-with-auth';
import { PreSummaryRequest } from './dto/pre-summary.request';
import type { PreSummaryResponse, SummaryResponse, TokenUsage } from './dto/summary.response';
import { SyncSummaryRequest } from './dto/sync-summary.request';
import { buildPreSummaryPrompt, buildSummaryPrompt } from './summary-prompt.builder';
import { mapGenerateToV1PreSummary, mapGenerateToV1Summary } from './summary-response.mapper';
import { ENHANCED_SUMMARY_SCHEMA, SIMPLIFIED_SUMMARY_SCHEMA } from './summary-schemas';

// Codes that can occur ONLY while establishing the connection, i.e. before any
// request bytes reached SMR. `/generate` is non-idempotent (billable
// generation), so a retry is safe only when the request provably never left
// the gateway — mirrors `SmrProxyController.CONNECT_PHASE_CODES`.
const CONNECT_PHASE_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND']);
const PRE_SUMMARY_DEFAULT_TEMPERATURE = 0.2;
const PRE_SUMMARY_DEFAULT_MAX_TOKENS = 800;

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
}

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
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
  ) {}

  @Post('summary/sync')
  @Authorize()
  @ApiOperation({ summary: 'v1-compatible synchronous medical summary (stateless shim over SMR /generate)' })
  async summarySync(@Body() body: SyncSummaryRequest, @Req() request?: RequestWithAuth): Promise<SummaryResponse> {
    const sessionData = body.session_data;
    const language = this.resolveLanguage(sessionData.session_metadata);
    // Enrichment logic (SMR_Summary_Endpoints.md §3.1): enabled when the flag is
    // set OR when pre_summary_text is present (the documented safety net).
    const includePreSummary = body.include_pre_summary_in_context === true || Boolean(sessionData.pre_summary_text?.trim());
    const useEnhanced = body.use_enhanced_format === true;

    const { system, user } = buildSummaryPrompt(sessionData, {
      department: body.department,
      visitType: body.visit_type,
      specialty: body.specialty,
      encounterType: body.encounter_type,
      language,
      includePreSummary,
    });

    const smrRequest: SmrGenerateRequest = {
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
    await this.applySmrModelSelection(smrRequest, request);

    const generated = await this.callSmrGenerate(smrRequest, 'Summary generation');

    try {
      return mapGenerateToV1Summary(generated.content, {
        sessionId: sessionData.session_id,
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
        createdAt: new Date(),
      });
    } catch (err) {
      throw this.buildGenerationFailure('Summary generation', err);
    }
  }

  @Post('presummary')
  @Authorize()
  @ApiOperation({ summary: 'v1-compatible department-aware pre-summary (stateless shim over SMR /generate)' })
  async presummary(@Body() body: PreSummaryRequest, @Req() request?: RequestWithAuth): Promise<PreSummaryResponse> {
    const { system, user } = buildPreSummaryPrompt(body);

    const smrRequest: SmrGenerateRequest = {
      system_prompt: system,
      prompt: user,
      temperature: body.temperature ?? PRE_SUMMARY_DEFAULT_TEMPERATURE,
      max_tokens: body.max_tokens ?? PRE_SUMMARY_DEFAULT_MAX_TOKENS,
    };
    await this.applySmrModelSelection(smrRequest, request);

    const generated = await this.callSmrGenerate(smrRequest, 'Pre-summary generation');

    try {
      return mapGenerateToV1PreSummary(generated.content, new Date());
    } catch (err) {
      throw this.buildGenerationFailure('Pre-summary generation', err);
    }
  }

  /** `session_metadata.language` ("en"/"ml") drives output language; default "en". */
  private resolveLanguage(metadata?: Record<string, unknown>): string {
    const language = metadata?.language;
    return typeof language === 'string' && language.trim() ? language.trim() : 'en';
  }
  private async applySmrModelSelection(request: SmrGenerateRequest, authRequest?: RequestWithAuth): Promise<void> {
    const tenantId = this.clsService.get('tenantId') ?? authRequest?.apiKey?.tenantId ?? undefined;
    const selection = await this.harnessPolicyService.resolveSmrSelection(tenantId);
    request.provider = selection.provider;
    request.model = selection.model;
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

  private async callSmrGenerate(request: SmrGenerateRequest, label: string): Promise<SmrGenerateResponse> {
    const base = this.getSmrBaseUrl();
    const maxRetries = 2;

    let lastErr: unknown;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const response = await this.httpService.axiosRef.post(`${base}/api/v1/generate`, request, {
          headers: this.getForwardHeaders(),
          timeout: 120_000,
        });
        return response.data as SmrGenerateResponse;
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

    throw this.buildUpstreamFailure(label, lastErr);
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
