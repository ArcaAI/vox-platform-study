/**
 * TASK-1050 W2h — the gateway → guardrail dry-run call (`POST /api/v1/guardrail/judge/dry-run`, lane W2a1).
 *
 * The internal-client shape of `GuardrailPromptScreenClient`: the shared internal token and the MANDATORY
 * `X-Tenant-Id`, here always the SYSTEM tenant (the dry run judges platform DRAFT configuration, not a
 * tenant's request). The body is sample text plus draft policy values; nothing is persisted on either side.
 * Any transport error, non-2xx, timeout or unreadable body is a `GuardrailDryRunUnavailableError`.
 */
import { HttpService } from '@nestjs/axios';
import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SYSTEM_TENANT_ID } from '@arcaai/domains';
import { TENANTLESS, internalServiceHeaders, resolveInternalAccessToken } from '../../common';
import { SecretsService } from '../baseServices/_meta/secrets/SecretsService';
import { GUARDRAIL_JUDGE_DEFAULTS, GUARDRAIL_JUDGE_TIMEOUT_KEY } from '../settings-registry/descriptors/guardrail-judge.descriptors';
import { IAppSettingsService } from '../baseServices/_meta/appSettings/IAppSettingsService';

export const GUARDRAIL_DRY_RUN_PATH = '/api/v1/guardrail/judge/dry-run';

export interface GuardrailDryRunCall {
  readonly lanes: readonly string[];
  readonly text?: string;
  readonly sampleId?: string;
  /** Draft `_metadata.policy` values, already validated against the catalogue. */
  readonly policyOverrides: Readonly<Record<string, unknown>>;
}

export class GuardrailDryRunUnavailableError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GuardrailDryRunUnavailableError';
  }
}

@Injectable()
export class GuardrailJudgeDryRunClient {
  private readonly logger = new Logger(GuardrailJudgeDryRunClient.name);
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

  /** The raw guardrail answer; the service maps it. */
  async run(call: GuardrailDryRunCall): Promise<Record<string, unknown>> {
    // One judge call per lane group, so the peer budget guardrail itself applies is the right ceiling here.
    const timeoutS =
      this.appSettings?.getValueWithDefault<number>(GUARDRAIL_JUDGE_TIMEOUT_KEY, GUARDRAIL_JUDGE_DEFAULTS[GUARDRAIL_JUDGE_TIMEOUT_KEY]) ??
      GUARDRAIL_JUDGE_DEFAULTS[GUARDRAIL_JUDGE_TIMEOUT_KEY];
    try {
      const response = await this.httpService.axiosRef.post(
        `${this.guardrailUrl}${GUARDRAIL_DRY_RUN_PATH}`,
        {
          lanes: call.lanes,
          ...(call.text !== undefined ? { text: call.text } : {}),
          ...(call.sampleId !== undefined ? { sample_id: call.sampleId } : {}),
          policy_overrides: call.policyOverrides,
        },
        {
          timeout: (timeoutS + 5) * 1000,
          headers: internalServiceHeaders({
            serviceToken: await resolveInternalAccessToken(this.secretsService, 'GUARDRAIL_SERVICE_TOKEN'),
            tenantId: SYSTEM_TENANT_ID,
            // Never used: the tenant id above is always set. Required by the helper's signature.
            tenantlessReason: TENANTLESS.CONTROL_PLANE,
          }),
        },
      );
      const body = response.data as unknown;
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        throw new GuardrailDryRunUnavailableError('Guardrail answered the dry run without a JSON object.');
      }
      return body as Record<string, unknown>;
    } catch (error) {
      if (error instanceof GuardrailDryRunUnavailableError) throw error;
      // The sample is synthetic, but log the error TYPE only, as every guardrail client does.
      this.logger.warn({ message: 'guardrail.dry_run.unavailable', error: error instanceof Error ? error.name : 'unknown' });
      throw new GuardrailDryRunUnavailableError('The guardrail judge dry run is unavailable.');
    }
  }
}
