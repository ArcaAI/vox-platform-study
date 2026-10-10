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
import { isNameFragment, isPiiValue, piiIdentifierClass } from './pii-value';

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
  /** Regions with only QUASI-identifier PII values (advisory unless a direct identifier is also present). */
  readonly quasiRegions: ReadonlySet<string>;
}

/** TASK-1059 C-3 — what the build-time medical judge said (region keys only, never text). */
export interface PromptMedicalScopeOutcome {
  readonly isMedical: boolean;
  /** The region keys judged off medical scope (`region_verdicts`); empty when none is attributable. */
  readonly offScopeRegions: readonly string[];
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
          // TASK-1050: recorded under its own caller; guardrail raises no client notice for it.
          caller: 'governed_prompt',
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
    return this.readOutcome(body, regions);
  }

  /**
   * TASK-1059 C-3 (owner OD-2) — the medical-scope judge over authored prompt pieces:
   * `POST /api/medical/validate` with `scope: "prompt"` and every piece an `instruction` region.
   * Prompts are judged here, at build time, and never at runtime. Fail-closed like `screenRegions`:
   * a transport error, a non-2xx (guardrail answers 503 when undetermined), a timeout, a body with no
   * `is_medical` or a `screened_regions` that does not cover every key sent is unavailable.
   */
  async validateMedicalScope(tenantId: string, regions: readonly PromptScreenRegion[]): Promise<PromptMedicalScopeOutcome> {
    const timeout =
      this.appSettings?.getValueWithDefault<number>('governedPrompt.screenTimeoutMs', DEFAULT_SCREEN_TIMEOUT_MS) ?? DEFAULT_SCREEN_TIMEOUT_MS;
    let body: Record<string, unknown> | undefined;
    try {
      const response = await this.httpService.axiosRef.post(
        `${this.guardrailUrl}/api/medical/validate`,
        { scope: 'prompt', regions: regions.map((region) => ({ key: region.key, text: region.text, trust: 'instruction' })) },
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
      // PHI-safe: the error TYPE, never the judged text.
      this.logger.warn({ message: 'governed-prompt.medical.unavailable', error: error instanceof Error ? error.name : 'unknown' });
      throw new PromptScreeningUnavailableError('Guardrail medical-scope judge is unavailable.');
    }
    if (typeof body?.is_medical !== 'boolean') {
      throw new PromptScreeningUnavailableError('Guardrail medical-scope judge answered without a verdict.');
    }
    const screened = new Set(Array.isArray(body.screened_regions) ? body.screened_regions : []);
    if (regions.some((region) => !screened.has(region.key))) {
      // Version-skew guard (TASK-1047): a region guardrail did not cover has no verdict.
      throw new PromptScreeningUnavailableError('Guardrail medical-scope judge did not cover every region.');
    }
    if (body.is_medical) return { isMedical: true, offScopeRegions: [] };
    const offScopeRegions = (Array.isArray(body.region_verdicts) ? body.region_verdicts : [])
      .filter((verdict) => (verdict as { is_medical?: unknown } | null)?.is_medical === false)
      .map((verdict) => (verdict as { key?: unknown }).key)
      .filter((key): key is string => typeof key === 'string');
    return { isMedical: false, offScopeRegions };
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

  private readOutcome(body: Record<string, unknown> | undefined, regions: readonly PromptScreenRegion[] = []): PromptScreenOutcome {
    const decision = body?.decision;
    if (decision !== 'allow' && decision !== 'block') {
      throw new PromptScreeningUnavailableError('Guardrail prompt screening answered without a decision.');
    }
    const reasons = Array.isArray(body?.reasons) ? body.reasons.filter((reason): reason is string => typeof reason === 'string') : [];
    const checks = Array.isArray(body?.checks) ? body.checks : [];
    const undetermined = checks.some((check) => (check as { outcome?: unknown } | null)?.outcome === 'undetermined');
    const piiRegions = new Set<string>();
    const quasiRegions = new Set<string>();
    for (const raw of Array.isArray(body?.pii_spans) ? body.pii_spans : []) {
      const region = (raw as { region?: unknown } | null)?.region;
      if (typeof region !== 'string') {
        // A span that names no region cannot be attributed to a piece; a guardrail that predates
        // FC-5 answers this way. Fail closed rather than register anything PASS.
        throw new PromptScreeningUnavailableError('Guardrail prompt screening returned a PII span without a region.');
      }
      // Owner decision 2026-10-06 ("Validate span values"): instruction text NAMES PII categories
      // ("… phone number or email"), which the detector labels; only a span that carries an actual
      // value (an address with @, digits in a phone / ID / date, a proper name) is a finding.
      const label = spanLabel(raw);
      const regionText = regions.find((candidate) => candidate.key === region)?.text;
      const span = (raw ?? {}) as { start?: unknown; end?: unknown };
      if (typeof span.start === 'number' && typeof span.end === 'number' && isNameFragment(label, regionText, span.start, span.end)) continue;
      if (!isPiiValue(label, spanText(raw, regionText))) continue;
      if (piiIdentifierClass(label) === 'direct') piiRegions.add(region);
      else quasiRegions.add(region);
    }
    for (const region of piiRegions) quasiRegions.delete(region);
    return { decision, reasons, undetermined, piiRegions, quasiRegions };
  }
}

function spanLabel(raw: unknown): string {
  const label = (raw as { label?: unknown } | null)?.label;
  return typeof label === 'string' ? label : '';
}

/** The span's text: sliced from its region by offsets when both are present, else its own `text`. */
function spanText(raw: unknown, regionText: string | undefined): string {
  const span = (raw ?? {}) as { start?: unknown; end?: unknown; text?: unknown };
  if (regionText !== undefined && typeof span.start === 'number' && typeof span.end === 'number' && span.end > span.start) {
    return regionText.slice(span.start, span.end);
  }
  return typeof span.text === 'string' ? span.text : '';
}
