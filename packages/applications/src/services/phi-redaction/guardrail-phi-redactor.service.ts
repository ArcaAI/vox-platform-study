import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { IPhiRedactor } from '../gate-edit-mining/IPhiRedactor';
import { SecretsService } from '../baseServices/_meta/secrets';
import { IAppSettingsService } from '../baseServices/_meta/appSettings/IAppSettingsService';
import { TENANTLESS, internalServiceHeaders, resolveInternalAccessToken } from '../../common';
import { IActiveUserContext } from '../../interfaces';

interface GuardrailRedactResponseBody {
  sanitized_text?: unknown;
}

/**
 * Fallback request timeout, used before the settings cache is warm or when the
 * row is absent. The authoritative value is the admin-managed
 * `phiRedaction.requestTimeoutMs` registry key.
 *
 * 120s rather than the original 30s: guardrail now chunks large inputs and
 * processes the chunks SEQUENTIALLY (`redact.py::_extract_spans`), which trades
 * a super-linear blow-up for a linear, bounded walk — correct, but proportional
 * to corpus size. Measured at the DNA processor's 100,000-char cap: ~9.7s of
 * real extraction on a CPU-only worker, which the old 30s budget would have
 * covered only until a busier or slower host. Every caller of this class is inside an
 * async job (NER, DNA report, exemplar mining), never a user-blocking request,
 * so the generous budget costs nothing on the latency path.
 */
const DEFAULT_REDACT_TIMEOUT_MS = 120_000;

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
    // Optional + trailing so existing positional fixtures keep their arity.
    // Absent ⇒ the code default below applies.
    @Optional() @Inject(IAppSettingsService) private readonly appSettingsService?: IAppSettingsService,
    // TASK-737 — the tenant for the outbound `X-Tenant-Id`. `IPhiRedactor.redact`
    // deliberately keeps its `(text, mode)` signature: this port has callers in
    // three unrelated features (sync NER, DNA reports, exemplar mining), and
    // widening the interface would ripple through all of them for a value every
    // one of those callers already runs under. CLS is where they already carry it
    // — including the BullMQ workers, which establish a worker session before
    // dispatch (`createWorkerSession`). Optional + trailing so existing positional
    // fixtures keep compiling; absent ⇒ the declared tenant-less marker, never an
    // omitted header.
    @Optional() private readonly clsService?: ClsService<IActiveUserContext>,
  ) {
    this.guardrailServiceUrl = this.configService.get<string>('GUARDRAIL_URL') ?? 'http://localhost:8863';
  }

  async redact(text: string, mode: 'pseudonymize' | 'full'): Promise<string> {
    // D-D: the ONE shared `INTERNAL_ACCESS_TOKEN` (`GUARDRAIL_SERVICE_TOKEN` is
    // only the migration fallback). TASK-737: `X-Tenant-Id` is MANDATORY — this
    // hop had no tenant on the wire at all, so guardrail resolved SYSTEM. Because
    // tenants may only TIGHTEN relative to SYSTEM, that silently redacted a
    // stricter tenant's PHI at the platform FLOOR, with nothing logged.
    const serviceToken = await resolveInternalAccessToken(this.secretsService, 'GUARDRAIL_SERVICE_TOKEN');
    const timeout =
      this.appSettingsService?.getValueWithDefault<number>('phiRedaction.requestTimeoutMs', DEFAULT_REDACT_TIMEOUT_MS) ?? DEFAULT_REDACT_TIMEOUT_MS;
    let response: { data?: unknown };
    try {
      response = await this.httpService.axiosRef.post(
        `${this.guardrailServiceUrl}/api/guardrail/redact`,
        { text, mode },
        {
          timeout,
          headers: internalServiceHeaders({
            serviceToken,
            tenantId: this.clsService?.get('tenantId'),
            tenantlessReason: TENANTLESS.PLATFORM_OPERATOR,
          }),
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
