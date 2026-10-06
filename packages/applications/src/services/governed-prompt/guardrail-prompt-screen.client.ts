/**
 * TASK-1047 — the authoring-time prompt screen: guardrail's inbound screen over REGIONS (FC-5),
 * one region per prompt piece, with PII spans, plus the policy version verdicts are valid under.
 *
 * A minimal internal client in the `GuardrailPiiDetector` shape: the ONE shared internal token and
 * the MANDATORY `X-Tenant-Id`. Fail-closed by construction — a transport error, a non-2xx answer, a
 * timeout or a body it cannot read is a `PromptScreeningUnavailableError`, never an "allow".
 */
import { HttpService } from '@nestjs/axios';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { TENANTLESS, internalServiceHeaders, resolveInternalAccessToken } from '../../common';
import { IAppSettingsService } from '../baseServices/_meta/appSettings/IAppSettingsService';
import { SecretsService } from '../baseServices/_meta/secrets/SecretsService';

/**
 * Fallback before the settings cache is warm. Authoring time is off the latency path and a long
 * composite is windowed by guardrail, so the budget is generous.
 */
const DEFAULT_SCREEN_TIMEOUT_MS = 120_000;
const DEFAULT_POLICY_VERSION_TIMEOUT_MS = 5_000;

export interface PromptScreenRegion {
  readonly key: string;
  readonly text: string;
}

/** What one screen said — booleans and region keys only, never text. */
export interface PromptScreenOutcome {
  readonly decision: 'allow' | 'block';
  /** The checks that blocked, in guardrail's evaluation order. */
  readonly reasons: readonly string[];
  /** A check could not run — guardrail blocked by fail-closed posture, not by a verdict. */
  readonly undetermined: boolean;
  /** The region keys guardrail found a PII span in. */
  readonly piiRegions: ReadonlySet<string>;
}

export class PromptScreeningUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'PromptScreeningUnavailableError';
  }
}

@Injectable()
export class GuardrailPromptScreenClient {
  private readonly logger = new Logger(GuardrailPromptScreenClient.name);
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

  async screenRegions(tenantId: string, regions: readonly PromptScreenRegion[]): Promise<PromptScreenOutcome> {
    const timeout =
      this.appSettings?.getValueWithDefault<number>('governedPrompt.screenTimeoutMs', DEFAULT_SCREEN_TIMEOUT_MS) ?? DEFAULT_SCREEN_TIMEOUT_MS;
    let body: Record<string, unknown> | undefined;
    try {
      const response = await this.httpService.axiosRef.post(
        `${this.guardrailUrl}/api/v1/guardrail/screen/inbound`,
        {
          text: '',
          regions: regions.map((region) => ({ key: region.key, text: region.text })),
          kind: 'prompt',
          wrap: false,
          include_pii_spans: true,
        },
        {
          timeout,
          headers: internalServiceHeaders({
            serviceToken: await resolveInternalAccessToken(this.secretsService, 'GUARDRAIL_SERVICE_TOKEN'),
            tenantId,
            tenantlessReason: TENANTLESS.CONTROL_PLANE,
          }),
        },
      );
      body = response.data as Record<string, unknown> | undefined;
    } catch (error) {
      // PHI-safe: the error TYPE, never the screened text.
      this.logger.warn({ message: 'governed-prompt.screen.unavailable', error: error instanceof Error ? error.name : 'unknown' });
      throw new PromptScreeningUnavailableError('Guardrail prompt screening is unavailable.');
    }
    return this.readOutcome(body);
  }

  /**
   * `GET /api/v1/guardrail/policy-version` → `{ policyVersion }`, resolved by guardrail for the
   * `X-Tenant-Id` tenant (its tenant → SYSTEM selection cascade). `null` on ANY failure, a 503
   * (guardrail could not resolve its config) included — unknown means nothing is governed.
   */
  async fetchPolicyVersion(tenantId: string): Promise<string | null> {
    try {
      const response = await this.httpService.axiosRef.get(`${this.guardrailUrl}/api/v1/guardrail/policy-version`, {
        timeout: DEFAULT_POLICY_VERSION_TIMEOUT_MS,
        headers: internalServiceHeaders({
          serviceToken: await resolveInternalAccessToken(this.secretsService, 'GUARDRAIL_SERVICE_TOKEN'),
          tenantId,
          tenantlessReason: TENANTLESS.CONTROL_PLANE,
        }),
      });
      const version = (response.data as { policyVersion?: unknown } | undefined)?.policyVersion;
      return typeof version === 'string' && version.trim().length > 0 ? version : null;
    } catch (error) {
      this.logger.warn({ message: 'governed-prompt.policy-version.unavailable', error: error instanceof Error ? error.name : 'unknown' });
      return null;
    }
  }

  private readOutcome(body: Record<string, unknown> | undefined): PromptScreenOutcome {
    const decision = body?.decision;
    if (decision !== 'allow' && decision !== 'block') {
      throw new PromptScreeningUnavailableError('Guardrail prompt screening answered without a decision.');
    }
    const reasons = Array.isArray(body?.reasons) ? body.reasons.filter((reason): reason is string => typeof reason === 'string') : [];
    const checks = Array.isArray(body?.checks) ? body.checks : [];
    const undetermined = checks.some((check) => (check as { outcome?: unknown } | null)?.outcome === 'undetermined');
    const piiRegions = new Set<string>();
    for (const raw of Array.isArray(body?.pii_spans) ? body.pii_spans : []) {
      const region = (raw as { region?: unknown } | null)?.region;
      if (typeof region !== 'string') {
        // A span that names no region cannot be attributed to a piece; a guardrail that predates
        // FC-5 answers this way. Fail closed rather than register anything PASS.
        throw new PromptScreeningUnavailableError('Guardrail prompt screening returned a PII span without a region.');
      }
      piiRegions.add(region);
    }
    return { decision, reasons, undetermined, piiRegions };
  }
}
