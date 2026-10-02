/**
 * The Prompt Inspector's PII detection: guardrail's inbound screen with `include_pii_spans` — the
 * SAME detection `apps/text` runs before a cloud call (`/api/v1/guardrail/screen/inbound`).
 *
 * A minimal internal client: `X-Service-Token` (the ONE shared internal token) and the
 * MANDATORY `X-Tenant-Id`. A failure is a 503 rather than an empty span list: a preview that
 * claimed "nothing detected" because the detector was down would show a cloud view with the
 * identifiers still in it.
 */
import { HttpService } from '@nestjs/axios';
import { Inject, Injectable, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { internalServiceHeaders, resolveInternalAccessToken, TENANTLESS } from '../../../common';
import { IAppSettingsService } from '../../baseServices/_meta/appSettings/IAppSettingsService';
import { SecretsService } from '../../baseServices/_meta/secrets/SecretsService';
import type { PreviewPiiSpan } from './preview-pseudonymizer';

/** Fallback before the settings cache is warm; the authoritative value is `phiRedaction.requestTimeoutMs`. */
const DEFAULT_TIMEOUT_MS = 120_000;

@Injectable()
export class GuardrailPiiDetector {
  private readonly logger = new Logger(GuardrailPiiDetector.name);
  private readonly guardrailUrl: string;

  constructor(
    private readonly httpService: HttpService,
    configService: ConfigService,
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
    @Optional() @Inject(IAppSettingsService) private readonly appSettings?: IAppSettingsService,
  ) {
    // Bootstrap TRANSPORT address (rule 00): the only sanctioned env default.
    this.guardrailUrl = configService.get<string>('GUARDRAIL_URL') ?? 'http://localhost:8863';
  }

  /** The PII spans of `text`, in CODE-POINT offsets. */
  async detect(text: string, tenantId: string): Promise<PreviewPiiSpan[]> {
    const timeout = this.appSettings?.getValueWithDefault<number>('phiRedaction.requestTimeoutMs', DEFAULT_TIMEOUT_MS) ?? DEFAULT_TIMEOUT_MS;
    let body: { pii_spans?: unknown } | undefined;
    try {
      const response = await this.httpService.axiosRef.post(
        `${this.guardrailUrl}/api/v1/guardrail/screen/inbound`,
        { text, kind: 'prompt', wrap: false, include_pii_spans: true },
        {
          timeout,
          headers: internalServiceHeaders({
            serviceToken: await resolveInternalAccessToken(this.secretsService, 'GUARDRAIL_SERVICE_TOKEN'),
            tenantId,
            tenantlessReason: TENANTLESS.CONTROL_PLANE,
          }),
        },
      );
      body = response.data as { pii_spans?: unknown } | undefined;
    } catch (error) {
      this.logger.warn({ message: 'Prompt preview PII detection failed', error: error instanceof Error ? error.name : 'unknown' });
      throw new ServiceUnavailableException({ code: 'GUARDRAIL_UNAVAILABLE', message: 'PII detection is unavailable, so the provider view cannot be shown.' });
    }
    if (!Array.isArray(body?.pii_spans)) return [];
    return body.pii_spans.flatMap((raw) => {
      const span = raw as { label?: unknown; start?: unknown; end?: unknown };
      return typeof span.label === 'string' && Number.isInteger(span.start) && Number.isInteger(span.end)
        ? [{ label: span.label, start: span.start as number, end: span.end as number }]
        : [];
    });
  }
}
