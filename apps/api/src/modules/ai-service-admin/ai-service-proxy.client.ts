import { HttpService } from '@nestjs/axios';
import { HttpException, Inject, Injectable, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';
import { IConfigService, SecretsService } from '@arcaai/applications';
import { isAxiosError } from 'axios';

import { describeCauseForOperator } from '../../filters/downstream-error';

/** opaque stand-ins. The cause goes to the log; the client gets these. */
const UPSTREAM_ERROR_MESSAGE = 'The AI service returned an error.';
const TRANSPORT_ERROR_MESSAGE = 'AI text analysis is temporarily unavailable. Please retry.';

const DEFAULT_GUARDRAIL_URL = 'http://localhost:8863';
const DEFAULT_NLP_URL = 'http://localhost:8864';
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Merged guardrail configuration read: the two read-only
 * config endpoints the Python service actually exposes, joined into one
 * document for the console. Shapes are owned by apps/guardrail — proxied
 * verbatim, never re-validated here.
 */
export interface GuardrailConfigResult {
  /** `GET /api/medical/config` — guardian engine settings (provider, model, thresholds). */
  medicalValidation: Record<string, unknown>;
  /** `GET /api/guardrail/types` — supported analysis types with descriptions. */
  analysisTypes: Record<string, unknown>;
}

/**
 * AiServiceProxyClient.
 *
 * Outbound half of the `/admin/ai-services` read plane: proxies the Guardrail
 * and NLP Python services' own health/config endpoints through the gateway so
 * the console never talks to them directly. READ-ONLY by design — neither
 * service exposes internal config mutation, so none is invented here.
 *
 * Upstream endpoints (source of truth: apps/guardrail, apps/nlp):
 *  - Guardrail `GET /api/health` — engine/GLiNER/Redis component checks
 *  - Guardrail `GET /api/medical/config` — guardian engine configuration
 *  - Guardrail `GET /api/guardrail/types` — supported analysis types
 *  - NLP `GET /api/v1/health` — per-model component checks
 *
 * Base URLs resolve from `IConfigService` (`GUARDRAIL_URL` / `NLP_URL`), falling
 * back to the local-dev ports.
 *
 * Auth: both services front their non-health routes with `X-Service-Token`
 * middleware, so every call here attaches it FAIL-CLOSED — an unresolved secret
 * still sends an empty header for the receiver to reject rather than silently
 * downgrading the hop to unauthenticated HTTP (same posture as
 * `AiInferenceClient.buildHeaders` / `HarnessOpsClient`). Omitting it made
 * guardrail answer 401 to `/api/medical/config` + `/api/guardrail/types`, and
 * because upstream statuses pass through verbatim the console saw a 401 on a
 * fully-authorized super-admin read. The health probes are auth-exempt upstream
 * and are unaffected by the header.
 *
 * Error contract mirrors HarnessOpsClient: upstream
 * HTTP errors pass through with their own status, transport failures become 503.
 */
@Injectable()
export class AiServiceProxyClient {
  private readonly logger = new Logger(AiServiceProxyClient.name);

  constructor(
    private readonly httpService: HttpService,
    // Optional so unit fixtures compile without the global ConfigModule.
    @Optional() @Inject(IConfigService) private readonly configService?: IConfigService,
    // Optional so unit fixtures compile without a mock; an unset token yields an
    // empty `X-Service-Token`, which a token-requiring receiver rejects
    // (fail-closed, same posture as `AiInferenceClient`).
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
  ) {}

  /** Guardrail detailed health (`/api/health`): engine, GLiNER, and Redis checks. */
  async guardrailStatus(): Promise<Record<string, unknown>> {
    return this.get(this.guardrailUrl(), '/api/health', 'GUARDRAIL_SERVICE_TOKEN');
  }

  /** Guardrail read-only configuration: medical-validation settings + analysis types. */
  async guardrailConfig(): Promise<GuardrailConfigResult> {
    const [medicalValidation, analysisTypes] = await Promise.all([
      this.get(this.guardrailUrl(), '/api/medical/config', 'GUARDRAIL_SERVICE_TOKEN'),
      this.get(this.guardrailUrl(), '/api/guardrail/types', 'GUARDRAIL_SERVICE_TOKEN'),
    ]);
    return { medicalValidation, analysisTypes };
  }

  /** NLP detailed health (`/api/v1/health`): per-model component checks. */
  async nlpStatus(): Promise<Record<string, unknown>> {
    return this.get(this.nlpUrl(), '/api/v1/health', 'NLP_SERVICE_TOKEN');
  }

  private guardrailUrl(): string {
    return this.configService?.getConfigValue('GUARDRAIL_URL') ?? DEFAULT_GUARDRAIL_URL;
  }

  private nlpUrl(): string {
    return this.configService?.getConfigValue('NLP_URL') ?? DEFAULT_NLP_URL;
  }

  /**
   * The `X-Service-Token` header is ALWAYS attached, even when the secret is
   * unresolved (empty value), so the receiver rejects it instead of the gateway
   * silently issuing an unauthenticated internal call.
   */
  private async buildHeaders(secretKey: 'GUARDRAIL_SERVICE_TOKEN' | 'NLP_SERVICE_TOKEN'): Promise<Record<string, string>> {
    return { 'X-Service-Token': (await this.secretsService?.getSecretOptional(secretKey)) ?? '' };
  }

  private async get(baseUrl: string, path: string, secretKey: 'GUARDRAIL_SERVICE_TOKEN' | 'NLP_SERVICE_TOKEN'): Promise<Record<string, unknown>> {
    try {
      const response = await this.httpService.axiosRef.get<Record<string, unknown>>(`${baseUrl}${path}`, {
        timeout: DEFAULT_TIMEOUT_MS,
        headers: await this.buildHeaders(secretKey),
      });
      return response.data;
    } catch (error) {
      throw this.toHttpError(error, `GET ${path}`);
    }
  }

  /**
   * Surface the Python service's own status + body when it responded, else a
   * 503 for transport errors (DNS/connect/timeout) — same contract as
   * HarnessOpsClient so console error handling stays uniform.
   */
  private toHttpError(error: unknown, action: string): HttpException {
    if (isAxiosError(error) && error.response) {
      this.logger.warn({ message: 'AI service upstream error', action, status: error.response.status });
      // see `harness-ops.client.ts`: an empty upstream body must not
      // fall back to the axios message (it carries the internal host:port).
      const body = error.response.data ?? { message: UPSTREAM_ERROR_MESSAGE };
      return new HttpException(body as string | Record<string, unknown>, error.response.status);
    }
    this.logger.error({ message: 'AI service transport error', action, ...describeCauseForOperator(error) });
    // cause to the log, capability to the client.
    return new ServiceUnavailableException(TRANSPORT_ERROR_MESSAGE);
  }
}
