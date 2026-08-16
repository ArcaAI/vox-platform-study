import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { Injectable, Logger, Optional } from '@nestjs/common';
import { IPhiRedactor } from '../gate-edit-mining/IPhiRedactor';
import { SecretsService } from '../baseServices/_meta/secrets';

interface GuardrailRedactResponseBody {
  sanitized_text?: unknown;
}

/**
 * `IPhiRedactor` implementation backed by the guardrail service's
 * `POST /api/guardrail/redact` (TASK-710). A pure HTTP client — structurally
 * identical to `GuardrailGroundednessTool` (`live-tool-registry.ts`), which is
 * the exemplar this follows for URL/token resolution.
 *
 * FAIL-CLOSED by construction: any transport error, non-2xx response, or a
 * response body that doesn't carry a string `sanitized_text` is a THROW, never
 * a fallback to the raw input. `IPhiRedactor`'s contract (see its doc) treats
 * a thrown redaction as "drop the candidate / abort the job" at every call
 * site — this class only needs to never swallow an error into a 200-shaped lie.
 */
@Injectable()
export class GuardrailPhiRedactor implements IPhiRedactor {
  private readonly logger = new Logger(GuardrailPhiRedactor.name);
  private readonly guardrailServiceUrl: string;

  constructor(
    private readonly httpService: HttpService,
    private readonly configService: ConfigService,
    // Optional so unit fixtures and non-DI construction paths compile; the
    // module registers SecretsService via the @Global SecretsModule in
    // production. Absent ⇒ an empty token is sent (guardrail's documented
    // empty-token dev/CI bypass — mirrors the groundedness executor).
    @Optional() private readonly secretsService?: SecretsService,
  ) {
    this.guardrailServiceUrl = this.configService.get<string>('GUARDRAIL_URL') ?? 'http://localhost:8863';
  }

  async redact(text: string, mode: 'pseudonymize' | 'full'): Promise<string> {
    const token = (await this.secretsService?.getSecretOptional('GUARDRAIL_SERVICE_TOKEN')) ?? '';
    let response: { data?: unknown };
    try {
      response = await this.httpService.axiosRef.post(
        `${this.guardrailServiceUrl}/api/guardrail/redact`,
        { text, mode },
        {
          timeout: 30000,
          headers: { 'Content-Type': 'application/json', 'X-Service-Token': token },
        },
      );
    } catch (error) {
      this.logger.warn({
        message: 'Guardrail redact call failed',
        mode,
        error: error instanceof Error ? error.message : String(error),
      });
      throw error instanceof Error ? error : new Error('Guardrail redact call failed');
    }

    const body = response.data as GuardrailRedactResponseBody | undefined;
    if (typeof body?.sanitized_text !== 'string') {
      // Malformed response is treated exactly like a transport error — never
      // fall back to the raw `text`.
      throw new Error('Guardrail redact response is missing sanitized_text');
    }
    return body.sanitized_text;
  }
}
