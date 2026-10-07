import { GUARDRAIL_NOTICE_DEFAULT_MESSAGES } from '@arcaai/types';
import { HttpService } from '@nestjs/axios';
import { BadRequestException, Inject, Injectable, Logger, Optional, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ClsService } from 'nestjs-cls';
import { TENANTLESS, internalServiceHeaders, resolveInternalAccessToken } from '../../common';
import { IActiveUserContext } from '../../interfaces';
import { IAppSettingsService } from '../baseServices/_meta/appSettings/IAppSettingsService';
import { SecretsService } from '../baseServices/_meta/secrets/SecretsService';
import type { GuardrailScreenCheckResponse, ScreenGuardrailRulesRequest, ScreenGuardrailRulesResponse } from './dto';
import { resolveGuardrailWorkingTenant } from './working-tenant';

export const IGuardrailRuleTestService = Symbol('IGuardrailRuleTestService');

export interface IGuardrailRuleTestService {
  screen(request: ScreenGuardrailRulesRequest): Promise<ScreenGuardrailRulesResponse>;
}

/** Fallback before the settings cache is warm; `guardrail.playground.screenTimeoutMs` overrides it. */
const DEFAULT_TIMEOUT_MS = 60_000;
const FOUR_WAY = new Set(['allow', 'warn', 'block', 'unverified']);

/**
 * TASK-1050 W2b — the console playground's "Test my rules" (`POST admin/guardrail/screen`).
 *
 * Screens the caller's text under the WORKING TENANT's effective rules by asking guardrail itself — the
 * same screen TEXT calls — so the answer is exactly what a generation would get: `X-Tenant-Id` = that
 * tenant (guardrail resolves tenant → SYSTEM), the shared internal token, the request id, and
 * `caller: 'playground'`, which is how guardrail's own evaluation record attributes it.
 *
 * AUTH-NOTE: the route's `read:TenantGuardrailPolicy` decides who may test. The tenant is resolved here
 * existence first ({@link resolveGuardrailWorkingTenant}: another tenant is 404, none is 400) BEFORE any
 * upstream call, so a tenant admin can only ever screen under its own rules.
 *
 * Persists nothing, and echoes no content: the containment envelope, the sanitized text and the PII span
 * VALUES guardrail returns never leave the gateway. A guardrail failure is 503 `GUARDRAIL_UNAVAILABLE`
 * with the gateway's own message — the upstream body (which may quote the text) is never relayed.
 */
@Injectable()
export class GuardrailRuleTestService implements IGuardrailRuleTestService {
  private readonly logger = new Logger(GuardrailRuleTestService.name);
  private readonly guardrailUrl: string;

  constructor(
    private readonly httpService: HttpService,
    configService: ConfigService,
    private readonly clsService: ClsService<IActiveUserContext>,
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
    @Optional() @Inject(IAppSettingsService) private readonly appSettings?: IAppSettingsService,
  ) {
    // Bootstrap TRANSPORT address (rule 00): the only sanctioned env default.
    this.guardrailUrl = configService.get<string>('GUARDRAIL_URL') ?? 'http://localhost:8863';
  }

  async screen(request: ScreenGuardrailRulesRequest): Promise<ScreenGuardrailRulesResponse> {
    const tenantId = resolveGuardrailWorkingTenant(this.clsService.get('tenantId'), this.clsService.get('user'));
    const regions = request.regions ?? [];
    const text = request.text ?? '';
    const direction = request.direction;

    let body: Record<string, unknown>;
    if (direction === 'inbound') {
      if ((text.length > 0) === (regions.length > 0)) {
        throw new BadRequestException('Send the inbound content as `text` or as `regions`, not both and not neither.');
      }
      body = { text, kind: 'prompt', wrap: false, include_pii_spans: false, caller: 'playground' };
      if (regions.length > 0) body.regions = regions.map(({ key, text: regionText, trust }) => ({ key, text: regionText, trust }));
    } else {
      if (text.length === 0) throw new BadRequestException('An outbound screen needs the response as `text`.');
      body = { response: text, caller: 'playground' };
      if (regions.length > 0) body.source_regions = regions.map(({ key, text: regionText }) => ({ key, text: regionText }));
    }

    let data: Record<string, unknown>;
    try {
      const response = await this.httpService.axiosRef.post(`${this.guardrailUrl}/api/v1/guardrail/screen/${direction}`, body, {
        timeout: this.timeoutMs(),
        headers: internalServiceHeaders({
          serviceToken: await resolveInternalAccessToken(this.secretsService, 'GUARDRAIL_SERVICE_TOKEN'),
          tenantId,
          tenantlessReason: TENANTLESS.CONTROL_PLANE,
        }),
      });
      data = (response.data ?? {}) as Record<string, unknown>;
    } catch (error) {
      const status = (error as { response?: { status?: number } })?.response?.status;
      // Status and error class only — the upstream body can quote the screened text.
      this.logger.warn({ message: 'Guardrail playground screen failed', upstreamStatus: status, error: error instanceof Error ? error.name : 'unknown' });
      if (status === 400 || status === 422) {
        throw new BadRequestException({ code: 'GUARDRAIL_SCREEN_REJECTED', message: 'Guardrail could not screen this input as given.' });
      }
      throw new ServiceUnavailableException({ code: 'GUARDRAIL_UNAVAILABLE', message: 'The safety guardrail is temporarily unavailable. Please retry shortly.' });
    }
    return toVerdict(direction, data);
  }

  private timeoutMs(): number {
    const value = this.appSettings?.getValueWithDefault<number>('guardrail.playground.screenTimeoutMs', DEFAULT_TIMEOUT_MS);
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : DEFAULT_TIMEOUT_MS;
  }
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function toCheck(raw: unknown): GuardrailScreenCheckResponse | null {
  if (typeof raw !== 'object' || raw === null) return null;
  const check = raw as Record<string, unknown>;
  const name = str(check.name);
  if (!name) return null;
  return {
    name,
    verdict: str(check.verdict) ?? str(check.outcome) ?? 'undetermined',
    action: str(check.action),
    actionTaken: str(check.actionTaken),
    score: typeof check.score === 'number' && Number.isFinite(check.score) ? check.score : null,
    category: str(check.category),
    reason: str(check.reason),
  };
}

/** A notice crosses only when its `defaultMessage` is exactly its key's fixed label (no free text). */
function isPhiFreeNotice(raw: unknown): raw is Record<string, unknown> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return false;
  const notice = raw as Record<string, unknown>;
  const label = typeof notice.messageKey === 'string' ? (GUARDRAIL_NOTICE_DEFAULT_MESSAGES as Record<string, string>)[notice.messageKey] : undefined;
  return label !== undefined && notice.defaultMessage === label && typeof notice.noticeId === 'string' && notice.schemaVersion === 1;
}

function toVerdict(direction: 'inbound' | 'outbound', data: Record<string, unknown>): ScreenGuardrailRulesResponse {
  const fourWay = str(data.guardrail_decision);
  const binary = str(data.decision);
  return {
    direction,
    decision: fourWay && FOUR_WAY.has(fourWay) ? fourWay : binary && FOUR_WAY.has(binary) ? binary : 'unverified',
    checks: (Array.isArray(data.checks) ? data.checks : []).map(toCheck).filter((check): check is GuardrailScreenCheckResponse => check !== null),
    notices: (Array.isArray(data.notices) ? data.notices : []).filter(isPhiFreeNotice),
    evaluationId: str(data.evaluation_id),
    policyVersion: str(data.policy_version),
  };
}
