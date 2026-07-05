import { HttpService } from '@nestjs/axios';
import { HttpException, Inject, Injectable, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';
import { IConfigService } from '@arcaai/applications';
import { isAxiosError } from 'axios';

const DEFAULT_GUARDRAIL_URL = 'http://localhost:8863';
const DEFAULT_NLP_URL = 'http://localhost:8864';
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Merged guardrail configuration read (TASK-419 item 3): the two read-only
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
 * AiServiceProxyClient (TASK-419 item 3).
 *
 * Outbound half of the `/admin/ai-services` read plane: proxies the Guardrail
 * and NLP Python services' own health/config endpoints through the gateway so
 * the console never talks to them directly. READ-ONLY by design — neither
 * service exposes internal config mutation, so none is invented here.
 *
 * Upstream endpoints (source of truth: apps/guardrail, apps/nlp):
 *  - Guardrail `GET /api/health`          — engine/GLiNER/Redis component checks
 *  - Guardrail `GET /api/medical/config`  — guardian engine configuration
 *  - Guardrail `GET /api/guardrail/types` — supported analysis types
 *  - NLP       `GET /api/v1/health`       — per-model component checks
 *
 * Base URLs resolve from `IConfigService` (`GUARDRAIL_URL` / `NLP_URL`), falling
 * back to the local-dev ports. Neither service uses service-token auth (plain
 * internal-network HTTP). Error contract mirrors HarnessOpsClient: upstream
 * HTTP errors pass through with their own status, transport failures become 503.
 */
@Injectable()
export class AiServiceProxyClient {
  private readonly logger = new Logger(AiServiceProxyClient.name);

  constructor(
    private readonly httpService: HttpService,
    // Optional so unit fixtures compile without the global ConfigModule.
    @Optional() @Inject(IConfigService) private readonly configService?: IConfigService,
  ) {}

  /** Guardrail detailed health (`/api/health`): engine, GLiNER, and Redis checks. */
  async guardrailStatus(): Promise<Record<string, unknown>> {
    return this.get(this.guardrailUrl(), '/api/health');
  }

  /** Guardrail read-only configuration: medical-validation settings + analysis types. */
  async guardrailConfig(): Promise<GuardrailConfigResult> {
    const [medicalValidation, analysisTypes] = await Promise.all([
      this.get(this.guardrailUrl(), '/api/medical/config'),
      this.get(this.guardrailUrl(), '/api/guardrail/types'),
    ]);
    return { medicalValidation, analysisTypes };
  }

  /** NLP detailed health (`/api/v1/health`): per-model component checks. */
  async nlpStatus(): Promise<Record<string, unknown>> {
    return this.get(this.nlpUrl(), '/api/v1/health');
  }

  private guardrailUrl(): string {
    return this.configService?.getConfigValue('GUARDRAIL_URL') ?? DEFAULT_GUARDRAIL_URL;
  }

  private nlpUrl(): string {
    return this.configService?.getConfigValue('NLP_URL') ?? DEFAULT_NLP_URL;
  }

  private async get(baseUrl: string, path: string): Promise<Record<string, unknown>> {
    try {
      const response = await this.httpService.axiosRef.get<Record<string, unknown>>(`${baseUrl}${path}`, {
        timeout: DEFAULT_TIMEOUT_MS,
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
      const body = error.response.data ?? { message: error.message };
      return new HttpException(body as string | Record<string, unknown>, error.response.status);
    }
    const message = error instanceof Error ? error.message : String(error);
    this.logger.error({ message: 'AI service transport error', action, error: message });
    return new ServiceUnavailableException(`AI service request failed (${action}): ${message}`);
  }
}
