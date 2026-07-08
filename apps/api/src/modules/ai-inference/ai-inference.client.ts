import { HttpService } from '@nestjs/axios';
import { HttpException, Inject, Injectable, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';
import { IConfigService } from '@arcaai/applications';
import { isAxiosError } from 'axios';

const DEFAULT_GUARDRAIL_URL = 'http://localhost:8863';
const DEFAULT_NLP_URL = 'http://localhost:8864';
// Guardrail analysis runs an LLM/GLiNER pass — allow more headroom than a health
// probe; NLP token-classification is a fast local model.
const GUARDRAIL_TIMEOUT_MS = 30_000;
const NLP_TIMEOUT_MS = 15_000;

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
 * back to the local-dev ports. Neither service uses service-token auth (plain
 * internal-network HTTP — no `*_SERVICE_TOKEN` secret exists, matching
 * `AiServiceProxyClient`). Error contract: upstream HTTP errors pass through
 * with their own status, transport failures become 503.
 */
@Injectable()
export class AiInferenceClient {
  private readonly logger = new Logger(AiInferenceClient.name);

  constructor(
    private readonly httpService: HttpService,
    // Optional so unit fixtures compile without the global ConfigModule.
    @Optional() @Inject(IConfigService) private readonly configService?: IConfigService,
  ) {}

  /** Content-safety / PII / prompt-injection analysis. Body is the upstream snake_case shape. */
  async analyzeGuardrail(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.post(this.guardrailUrl(), '/api/guardrail/analyze', body, GUARDRAIL_TIMEOUT_MS);
  }

  /** Medical NER (token classification). Body is the upstream snake_case shape. */
  async classifyTokens(body: Record<string, unknown>): Promise<Record<string, unknown>> {
    return this.post(this.nlpUrl(), '/api/v1/classify/tokens', body, NLP_TIMEOUT_MS);
  }

  private guardrailUrl(): string {
    return this.configService?.getConfigValue('GUARDRAIL_URL') ?? DEFAULT_GUARDRAIL_URL;
  }

  private nlpUrl(): string {
    return this.configService?.getConfigValue('NLP_URL') ?? DEFAULT_NLP_URL;
  }

  private async post(baseUrl: string, path: string, body: Record<string, unknown>, timeout: number): Promise<Record<string, unknown>> {
    try {
      const response = await this.httpService.axiosRef.post<Record<string, unknown>>(`${baseUrl}${path}`, body, { timeout });
      return response.data;
    } catch (error) {
      throw this.toHttpError(error, `POST ${path}`);
    }
  }

  /**
   * Surface the Python service's own status + body when it responded, else a
   * 503 for transport errors (DNS/connect/timeout) — same contract as
   * AiServiceProxyClient so console error handling stays uniform.
   */
  private toHttpError(error: unknown, action: string): HttpException {
    if (isAxiosError(error) && error.response) {
      this.logger.warn({ message: 'AI inference upstream error', action, status: error.response.status });
      const responseBody = error.response.data ?? { message: error.message };
      return new HttpException(responseBody as string | Record<string, unknown>, error.response.status);
    }
    const message = error instanceof Error ? error.message : String(error);
    this.logger.error({ message: 'AI inference transport error', action, error: message });
    return new ServiceUnavailableException(`AI inference request failed (${action}): ${message}`);
  }
}
