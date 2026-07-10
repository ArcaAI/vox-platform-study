import { HttpService } from '@nestjs/axios';
import { HttpException, Inject, Injectable, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';
import { IConfigService, SecretsService } from '@arcaai/applications';
import { isAxiosError } from 'axios';

const DEFAULT_GUARDRAIL_URL = 'http://localhost:8863';
const DEFAULT_NLP_URL = 'http://localhost:8864';
// Guardrail analysis runs an LLM/GLiNER pass — allow more headroom than a health
// probe; NLP token-classification is a fast local model.
const GUARDRAIL_TIMEOUT_MS = 30_000;
const NLP_TIMEOUT_MS = 15_000;

// PHI hygiene: the Guardrail/NLP upstream error body can ECHO the caller's
// clinical text (Guardrail moderates it; NLP runs NER over it), so it is NEVER
// forwarded to the console — only the upstream status is preserved. Mirrors the
// smr-proxy C4-05 posture (TASK-462).
const UPSTREAM_ERROR_MESSAGE = 'The AI inference service returned an error.';

/**
 * AiInferenceClient (TASK-446) — the OUTBOUND half of the user-plane
 * `/ai/*` inference proxy that backs the Agent Playground's Guardrails and NER
 * tabs. Distinct from the read-only `AiServiceProxyClient` (`/admin/ai-services`,
 * health/config): this one POSTs caller-supplied text to the services' inference
 * endpoints. Upstream shapes are owned by apps/guardrail / apps/nlp and proxied
 * verbatim — never re-validated here.
 *
 * Upstream endpoints (source of truth: apps/guardrail, apps/nlp):
 *  - Guardrail `POST /api/guardrail/analyze`     — content-safety / PII / prompt-injection
 *  - NLP       `POST /api/v1/classify/tokens`    — medical token classification (NER)
 *
 * Base URLs resolve from `IConfigService` (`GUARDRAIL_URL` / `NLP_URL`), falling
 * back to the local-dev ports.
 *
 * TASK-460 C4-02 — both hops carry caller clinical text (PHI), so each POST
 * attaches a FAIL-CLOSED `X-Service-Token` (`GUARDRAIL_SERVICE_TOKEN` /
 * `NLP_SERVICE_TOKEN` via SecretsService), mirroring the harness outbound
 * `HarnessOpsClient.buildHeaders` pattern: an unresolved secret still sends an
 * empty header value for the receiver to reject, rather than silently omitting
 * auth. Error contract: upstream HTTP errors pass through with their own
 * status, transport failures become 503.
 */
@Injectable()
export class AiInferenceClient {
  private readonly logger = new Logger(AiInferenceClient.name);

  constructor(
    private readonly httpService: HttpService,
    // Optional so unit fixtures compile without the global ConfigModule.
    @Optional() @Inject(IConfigService) private readonly configService?: IConfigService,
    // Optional so unit fixtures compile without a mock; an unset token yields an
    // empty `X-Service-Token`, which a token-requiring receiver rejects
    // (fail-closed — TASK-460 C4-02, same posture as `HarnessOpsClient`).
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
  ) {}

  /** Content-safety / PII / prompt-injection analysis. Body is the upstream snake_case shape. */
  async analyzeGuardrail(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.post(this.guardrailUrl(), '/api/guardrail/analyze', body, GUARDRAIL_TIMEOUT_MS, 'GUARDRAIL_SERVICE_TOKEN');
  }

  /** Medical NER (token classification). Body is the upstream snake_case shape. */
  async classifyTokens(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.post(this.nlpUrl(), '/api/v1/classify/tokens', body, NLP_TIMEOUT_MS, 'NLP_SERVICE_TOKEN');
  }

  private guardrailUrl(): string {
    return this.configService?.getConfigValue('GUARDRAIL_URL') ?? DEFAULT_GUARDRAIL_URL;
  }

  private nlpUrl(): string {
    return this.configService?.getConfigValue('NLP_URL') ?? DEFAULT_NLP_URL;
  }

  /**
   * TASK-460 C4-02 — mirror the harness outbound `buildHeaders` pattern: the
   * `X-Service-Token` header is ALWAYS attached. When the secret is unset the
   * empty value is still sent so the receiver rejects it (fail-closed), never
   * silently downgrading a PHI-bearing hop to unauthenticated HTTP.
   */
  private async buildHeaders(secretKey: 'GUARDRAIL_SERVICE_TOKEN' | 'NLP_SERVICE_TOKEN'): Promise<Record<string, string>> {
    const token = (await this.secretsService?.getSecretOptional(secretKey)) ?? '';
    return {
      'Content-Type': 'application/json',
      'X-Service-Token': token,
    };
  }

  private async post(
    baseUrl: string,
    path: string,
    body: Record<string, unknown>,
    timeout: number,
    secretKey: 'GUARDRAIL_SERVICE_TOKEN' | 'NLP_SERVICE_TOKEN',
  ): Promise<Record<string, unknown>> {
    try {
      const response = await this.httpService.axiosRef.post<Record<string, unknown>>(`${baseUrl}${path}`, body, {
        timeout,
        headers: await this.buildHeaders(secretKey),
      });
      return response.data;
    } catch (error) {
      throw this.toHttpError(error, `POST ${path}`);
    }
  }

  /**
   * Surface the Python service's own STATUS when it responded — the upstream
   * body is REDACTED (it can echo caller PHI; see UPSTREAM_ERROR_MESSAGE), never
   * forwarded to the console — else a 503 for transport errors
   * (DNS/connect/timeout).
   */
  private toHttpError(error: unknown, action: string): HttpException {
    if (isAxiosError(error) && error.response) {
      const status = error.response.status;
      // Log status/action only — never the upstream body (potential PHI).
      this.logger.warn({ message: 'AI inference upstream error (body redacted — may contain PHI)', action, status });
      return new HttpException(UPSTREAM_ERROR_MESSAGE, status);
    }
    const message = error instanceof Error ? error.message : String(error);
    this.logger.error({ message: 'AI inference transport error', action, error: message });
    return new ServiceUnavailableException(`AI inference request failed (${action}): ${message}`);
  }
}
