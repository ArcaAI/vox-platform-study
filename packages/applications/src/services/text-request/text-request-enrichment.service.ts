import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { IActiveUserContext } from '../../interfaces';
import { IAiRuntimeProfileService } from '../ai-runtime-profile/IAiRuntimeProfileService';
import { IProviderConnectionService, ResolvedProviderOverrides } from '../ai-provider-connection/IProviderConnectionService';
import { isCloudByoProvider } from '../ai-provider-connection/constants';
import { assertProviderAvailable } from '../ai-provider-connection/assert-provider-available';

/**
 * The ONE implementation of the two enrichments every outgoing SMR
 * `/api/v1/generate` body must carry: the caller tenant's BYO cloud credential
 * (`provider_overrides`) and the resolved hyperparameter profile.
 *
 * Extracted VERBATIM out of `TextProxyController` (BUG-018 defect 3) because a
 * second caller — the prompt-template test bench — was posting to SMR directly
 * and therefore silently ran on platform credentials with no runtime profile.
 * Both callers now share this service, so there is exactly one place where the
 * fail-open/fail-closed semantics live.
 *
 * Model IDENTITY is deliberately NOT here: the proxy resolves it through
 * `HarnessPolicyService`, the prompt-test path through `IAiTaskDefaultService`.
 * Which model to run is each caller's own concern.
 */
@Injectable()
export class TextRequestEnrichmentService {
  private readonly logger = new Logger(TextRequestEnrichmentService.name);

  constructor(
    private readonly clsService: ClsService<IActiveUserContext>,
    @Optional()
    @Inject(IAiRuntimeProfileService)
    private readonly aiRuntimeProfileService?: IAiRuntimeProfileService,
    @Optional()
    @Inject(IProviderConnectionService)
    private readonly aiProviderConnectionService?: IProviderConnectionService,
  ) {}

  /**
   * Fold the caller tenant's BYO cloud credential into the forwarded
   * body as `provider_overrides`.
   *
   * Three invariants:
   *   - CLOUD ONLY. A self-host provider (ollama/lm-studio/vllm/llama-cpp/
   *     built-in) is platform infrastructure; its endpoint is never a tenant
   *     credential, and we do not even query for one.
   *   - MINIMAL EXPOSURE. Only the entry for the RESOLVED provider is
   *     forwarded, so a tenant holding both azure and bedrock keys never ships
   *     the unused one to the service.
   *   - FAIL OPEN. A resolver error injects nothing and the request proceeds on
   *     the SYSTEM/env platform credentials — a broken BYO key must degrade,
   *     not take generation down. This deliberately differs from the
   *     fail-closed model-IDENTITY path.
   */
  async applyTenantProviderOverrides<T extends { provider?: string }>(target: T): Promise<T> {
    const provider = target.provider;
    // SMR is the LLM capability, so the service discriminator is always `llm`
    // (C2/C5). The 1-arg transition shims are retired here.
    if (!this.aiProviderConnectionService || !provider || !isCloudByoProvider('llm', provider)) {
      return target;
    }
    const tenantId = this.clsService.get('tenantId');
    if (!tenantId) return target;

    // The resolver cascades the tenant's own row over the
    // SYSTEM-tenant platform default, and each entry's `funding` label travels
    // with it so SMR meters platform-funded generation as CLOUD rather than as
    // the tenant's own BYOK.
    let resolved: ResolvedProviderOverrides;
    try {
      resolved = await this.aiProviderConnectionService.resolveTenantCloudOverrides('llm', tenantId);
    } catch (error) {
      // Non-secret log only. The resolver itself already logs per-credential
      // decrypt failures with `{tenantId, provider, keyVersion}`; this covers a
      // whole-lookup failure.
      this.logger.warn({
        message: 'Tenant provider-credential resolution failed; forwarding with platform credentials (fail-open)',
        provider,
        error: error instanceof Error ? error.message : String(error),
      });
      return target;
    }

    const entry = resolved.overrides[provider];
    if (entry) {
      (target as Record<string, unknown>).provider_overrides = { [provider]: entry };
      return target;
    }

    // No credential for the SELECTED provider. When the SYSTEM tier was
    // deliberately SUPPRESSED — the tenant vetoed this provider (409) or holds
    // no platform-default entitlement (403) — say so. Deliberately OUTSIDE the
    // fail-open catch above: a policy refusal is not a lookup failure, and
    // swallowing it would return the unattributable 503 this exists to replace.
    assertProviderAvailable(resolved, 'llm', provider);
    return target;
  }

  /**
   * Inject the resolved hyperparameter profile into the forwarded body.
   *
   * Two invariants:
   *   - CALLER WINS. Only keys the caller did NOT set are filled in, so SDK
   *     fidelity is preserved exactly as it is for `model`.
   *   - FAIL-OPEN. A resolver error injects nothing and the request proceeds on
   *     the service's own env defaults.
   *
   * Field names are snake_case to match the SMR wire contract; SMR ignores
   * unknown body fields.
   */
  async applyTextRuntimeProfile<T extends { provider?: string; model?: string }>(target: T): Promise<T> {
    if (!this.aiRuntimeProfileService || !target.provider || !target.model) {
      return target;
    }

    try {
      const profile = await this.aiRuntimeProfileService.resolveProfile(target.provider, target.model);
      if (profile.isEmpty) {
        return target;
      }

      const body = target as Record<string, unknown>;
      const assign = (key: string, value: unknown): void => {
        // `undefined` = caller did not set it. An explicit caller value —
        // including 0 or false — is preserved.
        if (value !== null && body[key] === undefined) {
          body[key] = value;
        }
      };

      assign('temperature', profile.temperature);
      assign('top_p', profile.topP);
      assign('max_tokens', profile.maxTokens);
      assign('context_length', profile.contextLength);
      assign('timeout_s', profile.timeoutS);
      assign('keep_alive_seconds', profile.keepAliveSeconds);
      assign('extra', profile.extraJson);
    } catch (error) {
      this.logger.warn({
        message: 'Runtime-profile resolution failed; forwarding without injected parameters (fail-open)',
        provider: target.provider,
        model: target.model,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    return target;
  }
}
