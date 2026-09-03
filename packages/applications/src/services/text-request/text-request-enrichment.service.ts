import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { IActiveUserContext } from '../../interfaces';
import { IAiRuntimeProfileService } from '../ai-runtime-profile/IAiRuntimeProfileService';
import { IProviderConnectionService, ResolvedProviderOverrides } from '../ai-provider-connection/IProviderConnectionService';
import { isCloudByoProvider } from '../ai-provider-connection/constants';
import { assertProviderAvailable } from '../ai-provider-connection/assert-provider-available';
import { EffectiveSettingsService } from '../settings-registry/effective-settings.service';
import { TEXT_GUARDRAIL_POLICY_PUSH_FIELDS } from '../settings-registry/descriptors/text-guardrail-policy.descriptors';

/**
 * The ONE implementation of the two enrichments every outgoing TEXT
 * `/api/v1/generate` body must carry: the caller tenant's BYO cloud credential
 * (`provider_overrides`) and the resolved hyperparameter profile.
 *
 * Extracted VERBATIM out of `TextProxyController` (BUG-018 defect 3) because a
 * second caller — the prompt-template test bench — was posting to TEXT directly
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
    // Backs `applyTenantGuardrailPolicy`. @Optional for the same reason as the
    // two above: a composition that never pushes moderation policy (and every
    // existing positional test fixture) keeps its arity, and an unwired
    // resolver pushes NOTHING — which is precisely "this tenant has no
    // opinion", the state the receiving service already handles.
    @Optional()
    private readonly effectiveSettings?: EffectiveSettingsService,
  ) {}

  /**
   * Fold the resolved BYO credential for this request's provider into the
   * forwarded body as `provider_overrides`.
   *
   * Three invariants:
   *   - EVERY PROVIDER IS ASKED ABOUT. A credential may come from the tenant's
   *     own row (cloud BYO only) or from the SYSTEM-tenant platform default
   *     (cloud OR self-host). Which of those may serve is the RESOLVER's
   *     decision, not this call site's — see the note below.
   *   - MINIMAL EXPOSURE. Only the entry for the RESOLVED provider is
   *     forwarded, so a tenant holding both azure and bedrock keys never ships
   *     the unused one to the service.
   *   - FAIL OPEN. A resolver error injects nothing and the request proceeds on
   *     the SYSTEM/env platform credentials — a broken BYO key must degrade,
   *     not take generation down. This deliberately differs from the
   *     fail-closed model-IDENTITY path.
   *
   * C.1 — this method used to short-circuit on
   * `isCloudByoProvider('llm', provider)` and return BEFORE the resolver was
   * called, which made P1-C's resolver fix undeliverable on the TEXT path. That
   * predicate answers "may a TENANT OWN a row for this provider?", and it was
   * being used to answer "may the PLATFORM SERVE this provider?" — two
   * different questions. A super-admin-keyed self-host engine (vLLM,
   * openai-compat) is platform INFRASTRUCTURE and must reach every tenant, so
   * `TEXT_OPENAI_COMPAT_API_KEY` / `TEXT_VLLM_API_KEY` had no migration target
   * despite being listed as migratable. The guards that actually matter all
   * live in the resolver and are unchanged: a keyless row injects on NEITHER
   * tier (so a `base_url` still cannot become a credential), the TENANT tier
   * still refuses non-cloud rows, and cloud SYSTEM rows stay entitlement-gated
   * while self-host SYSTEM rows do not.
   */
  async applyTenantProviderOverrides<T extends { provider?: string }>(target: T): Promise<T> {
    const provider = target.provider;
    // TEXT is the LLM capability, so the service discriminator is always `llm`
    // (C2/C5). The 1-arg transition shims are retired here.
    if (!this.aiProviderConnectionService || !provider) {
      return target;
    }
    const tenantId = this.clsService.get('tenantId');
    if (!tenantId) return target;

    // The resolver cascades the tenant's own row over the
    // SYSTEM-tenant platform default, and each entry's `funding` label travels
    // with it so TEXT meters platform-funded generation as CLOUD rather than as
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
    //
    // Scoped to CLOUD providers, and that scoping is load-bearing now that the
    // self-host path reaches here too. Both suppression reasons are statements
    // about platform SPEND on a vendor account: the veto set is built only from
    // cloud rows (a tenant cannot own a self-host row to veto), and the
    // entitlement gate governs the platform's vendor spend. For a self-host
    // provider "no entry" therefore means "no DB opinion — use the service's
    // env configuration", which is the pre-existing downstream fallback. Without
    // this scope an unentitled tenant would get a 403 for an unconfigured
    // self-hosted engine the entitlement was never meant to cover.
    if (isCloudByoProvider('llm', provider)) {
      assertProviderAvailable(resolved, 'llm', provider);
    }
    return target;
  }

  /**
   * Push the caller tenant's OWN input-moderation policy into the forwarded
   * body as `guardrail_policy`.
   *
   * The producing half of the D-1 push contract whose receiving half already
   * existed: `GenerateRequest.guardrail_policy`
   * (`apps/text/src/text/models/requests.py`), folded over the platform posture
   * by `core/guardrail_posture.resolve_posture`. Absent it, the platform
   * default stood for every tenant and the per-tenant half of the split was
   * unreachable.
   *
   * Why these two fields and no others: `require_medical` and
   * `include_reasoning` are the parts of the posture that legitimately differ
   * BETWEEN tenants — a non-clinical tenant needs medical enforcement off while
   * every other tenant keeps it on. The rest (`enabled`, the retry budget) are
   * platform capacity decisions and travel the PULL channel instead, and the
   * FAIL POSTURE travels neither: an errored guardrail can never allow.
   *
   * Three invariants:
   *   - ABSENCE IS NOT `false`. A field is pushed ONLY when the cascade reports
   *     `sourceScope: 'tenant'` — a row that actually exists under this tenant.
   *     A `system`/`code-default` resolution is the cascade falling through,
   *     i.e. NO OPINION, and pushing the descriptor default there would be
   *     indistinguishable on the wire from a tenant that chose it — pinning the
   *     tenant to today's platform value forever after. The receiving field is
   *     `bool | None` precisely to keep those two states apart.
   *   - A WRONG-TYPED ROW IS REFUSED, not coerced. Same posture as the pull
   *     path's `matchesDataType` gate: a control-plane defect must leave the
   *     consumer on its own value rather than silently supply another one.
   *   - FAIL OPEN. A resolver error pushes nothing and the request proceeds on
   *     the platform posture. Note this method has no policy-refusal
   *     counterpart to `applyTenantProviderOverrides`'s `assertProviderAvailable`
   *     — there is no veto or entitlement to state here, so everything really
   *     is a lookup failure and the whole body belongs inside the catch. That
   *     is why the split above it stays where it is rather than being
   *     generalised over both methods.
   */
  async applyTenantGuardrailPolicy<T extends object>(target: T): Promise<T> {
    if (!this.effectiveSettings) return target;
    const tenantId = this.clsService.get('tenantId');
    if (!tenantId) return target;

    const policy: Record<string, boolean> = {};
    try {
      for (const [key, field] of TEXT_GUARDRAIL_POLICY_PUSH_FIELDS) {
        const resolved = await this.effectiveSettings.resolveEffective(key, { tenantId, departmentId: null, doctorId: null });
        // Not this tenant's row ⇒ no opinion ⇒ nothing to say.
        if (resolved.sourceScope !== 'tenant') continue;
        if (typeof resolved.value !== 'boolean') {
          this.logger.warn({
            message: 'Tenant guardrail-policy row is not a boolean — refusing it; the platform posture stands for this field',
            key,
            received: typeof resolved.value,
          });
          continue;
        }
        policy[field] = resolved.value;
      }
    } catch (error) {
      // Non-secret log only, matching the sibling enrichments.
      this.logger.warn({
        message: 'Tenant guardrail-policy resolution failed; forwarding without a pushed policy (fail-open)',
        error: error instanceof Error ? error.message : String(error),
      });
      return target;
    }

    if (Object.keys(policy).length > 0) {
      (target as Record<string, unknown>).guardrail_policy = policy;
    }
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
   * Field names are snake_case to match the TEXT wire contract; TEXT ignores
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
