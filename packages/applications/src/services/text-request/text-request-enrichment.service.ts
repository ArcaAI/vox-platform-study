import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { IActiveUserContext } from '../../interfaces';
import { IProviderConnectionService, ResolvedProviderOverrides } from '../ai-provider-connection/IProviderConnectionService';
import { isCloudByoProvider } from '../ai-provider-connection/constants';
import { assertProviderAvailable } from '../ai-provider-connection/assert-provider-available';
import { EffectiveSettingsService } from '../settings-registry/effective-settings.service';
import { TEXT_GUARDRAIL_POLICY_PUSH_FIELDS } from '../settings-registry/descriptors/text-guardrail-policy.descriptors';
import type { TextGuardrailPostureKey } from '../settings-registry/descriptors/text-provider-connections.descriptors';
import type { GuardrailDisposition } from '../usageLedger/usage-attributes';
import { REASONING_EFFORT_EXTRA_KEY, readAgentReasoning, reasoningExtra } from '../agent/agent-reasoning';
import {
  TEXT_REASONING_DEFAULT_EFFORTS,
  TEXT_REASONING_DEFAULT_EFFORT_KEY,
  TEXT_REASONING_ENGINE_DEFAULT,
} from '../settings-registry/descriptors/text-reasoning.descriptors';

/**
 * The ONE implementation of the enrichments every outgoing TEXT
 * `/api/v1/generate` body must carry: the caller tenant's BYO cloud credential
 * (`provider_overrides`) and its pushed moderation policy. (The hyperparameter
 * profile it used to inject went with `AiRuntimeProfile` — TASK-862; generation
 * parameters and engine extras now belong to the Agent, TASK-863.)
 *
 * Extracted VERBATIM out of `TextProxyController` (BUG-018 defect 3) because a
 * second caller — the prompt-template test bench — was posting to TEXT directly
 * and therefore silently ran on platform credentials with no runtime profile.
 * Both callers now share this service, so there is exactly one place where the
 * fail-open/fail-closed semantics live.
 *
 * Model IDENTITY is deliberately NOT here: the proxy resolves it through
 * `HarnessPolicyService`, the prompt-test path through `TextAgentResolverService`.
 * Which model to run is each caller's own concern.
 */
@Injectable()
export class TextRequestEnrichmentService {
  private readonly logger = new Logger(TextRequestEnrichmentService.name);

  constructor(
    private readonly clsService: ClsService<IActiveUserContext>,
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
  async applyTenantProviderOverrides<T extends { provider?: string; provider_overrides?: unknown }>(target: T): Promise<T> {
    const provider = target.provider;
    // TASK-876 — a caller that already carries `provider_overrides` has resolved the credential
    // FOR THE ROW IT IS ABOUT TO RUN (a `core.agent` candidate: the tenant's own agent, or the
    // SYSTEM platform default it fell back to). Recomputing it from the CLS tenant here would
    // silently re-fund the call as that tenant's BYOK even when the platform's row is serving —
    // the `funding` label on the entry is what TEXT meters, so the two must not disagree. The
    // resolver already applied the veto/entitlement policy for that row, so nothing is skipped
    // by returning early.
    if ((target as { provider_overrides?: unknown }).provider_overrides) {
      return target;
    }
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
      // MERGED, never assigned: `applyGuardrailDecision` writes `enabled` into the same
      // block, and the two enrichments have no fixed order across the five producers. An
      // assignment here would let a caller's ordering decide whether a tenant's opt-out
      // survived — a clinical gate must not depend on that.
      const record = target as Record<string, unknown>;
      const existing = isPlainObject(record.guardrail_policy) ? record.guardrail_policy : {};
      record.guardrail_policy = { ...existing, ...policy };
    }
    return target;
  }

  /**
   * TASK-890 §3.14 (OD-R) — write THIS call's guardrail decision onto the outgoing body.
   *
   * The decision itself is folded by `resolveGuardrailDecision` (`@arcaai/workflow-contract`:
   * node > workflow > agent > on) and reaches here already answered. This method is the ONE
   * place it becomes a wire field, so all five producers state it identically and none of them
   * hand-rolls the key.
   *
   * Three properties worth stating, because each is easy to lose:
   *
   *   - EXPLICIT IN BOTH DIRECTIONS. `enabled: true` is written, not omitted. On the wire it is
   *     a different statement from an absent block: TEXT can then distinguish "screened because
   *     a decision said so" from "no opinion — the platform posture governs", and the usage
   *     ledger records `screened` rather than inferring it.
   *   - IT ONLY EVER SUBTRACTS. A pushed `true` cannot turn a platform kill switch back on;
   *     `apps/text` keeps `platform.enabled` as the floor (`core/guardrail_posture.py`). So this
   *     is safe to send unconditionally.
   *   - IT MERGES. `applyTenantGuardrailPolicy` owns the other two fields of the same block.
   *
   * Synchronous and pure: unlike its siblings it resolves nothing, so there is no failure mode
   * to degrade — which is what lets a producer state the decision without a `try`/`catch` that
   * could swallow it.
   */
  applyGuardrailDecision<T extends object>(target: T, decision: { enabled: boolean }): T {
    const record = target as Record<string, unknown>;
    const existing = isPlainObject(record.guardrail_policy) ? record.guardrail_policy : {};
    record.guardrail_policy = { ...existing, enabled: decision.enabled };
    return target;
  }

  /**
   * The SCREENING DISPOSITION of a call, for the usage ledger's `guardrail` attribute.
   *
   * Three values, and the third is why this is a lookup rather than a boolean: `platform_off`
   * (the `text.externalGuardrail.enabled` kill switch is off, so nobody's opt-out was even
   * consulted), `opted_out` (a tenant decision on the record) and `screened`. Collapsing the
   * first two would let a deployment that never turned the platform gate on look like a fleet of
   * tenants who each chose to run unscreened.
   *
   * Read here rather than taken from the TEXT response because the ledger row must be
   * attributable even when the response carries nothing about screening — and because the
   * gateway is where the switch already resolves (`global-kv`, SYSTEM-scope).
   *
   * FAIL HONEST, not fail-`screened`: if the switch cannot be read the answer falls back to the
   * DECISION this gateway made, which is the half it knows for certain. Claiming `screened` on
   * an unreadable control plane would put a false safety record in the billing plane.
   */
  async guardrailDisposition(decision: { enabled: boolean }): Promise<GuardrailDisposition> {
    const fromDecision: GuardrailDisposition = decision.enabled ? 'screened' : 'opted_out';
    if (!this.effectiveSettings) return fromDecision;
    const tenantId = this.clsService.get('tenantId');
    try {
      const resolved = await this.effectiveSettings.resolveEffective(PLATFORM_GUARDRAIL_SWITCH_KEY, {
        tenantId: tenantId ?? null,
        departmentId: null,
        doctorId: null,
      });
      if (resolved.value === false) return 'platform_off';
    } catch (error) {
      this.logger.warn({
        message: 'Platform guardrail switch could not be resolved; recording this call by its own decision',
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return fromDecision;
  }

  /**
   * Layer the ENGINE RIDE-ALONGS a resolved agent authored onto an outbound
   * `/api/v1/generate` body, as `extra`.
   *
   * ## What changed, and what did not
   *
   * TASK-862 retired `AiRuntimeProfile` and left this method a NO-OP, with the note that
   * ride-alongs "are supplied by the Agent's parameters (TASK-863)". TASK-891 C2 is that
   * sentence made true for the first ride-along anyone actually needs: the reasoning
   * posture of `parameters.generation.reasoning` (OD-4).
   *
   * It adds NO transport. `GenerateRequest.extra` is already declared on `apps/text` and
   * already forwarded as `extra_body` to the OpenAI-compatible family — its own field
   * comment names `reasoning_effort` as the example. A caller that passes no `generation`
   * (every caller but the realtime agent path today) gets the previous no-op exactly.
   *
   * ## Merge rules
   *
   * The CALLER WINS, per key. A call site that already set `extra.reasoning_effort` has
   * made a decision about this specific request, and an agent-level default must not
   * silently overwrite it — the same precedence `applyTenantProviderOverrides` gives a
   * caller-supplied `provider_overrides`.
   *
   * ## The cascade (TASK-968)
   *
   * TASK-891 gave the posture ONE tier — the agent — so an agent that authored nothing
   * resolved to the ENGINE's default, which on `gemma-4-e2b-it-qat` measured 5168 ms /
   * 184 reasoning tokens against 1237 ms / 30 at `minimal`. The platform default
   * (`text.reasoning.defaultEffort`) is the second tier, so this now reads the way every
   * other cascade in the platform does:
   *
   *     the agent's authored block  →  the platform default  →  nothing
   *
   * It fills ABSENCE ONLY. An agent that authored `{ enabled: true }` with no effort still
   * sends nothing: `reasoningExtra` refuses to invent a budget for an agent that asked to
   * reason without naming one, and the platform tier must not answer over an opinion — it
   * answers where there is none. That is the `AiProviderConnection` rule verbatim.
   */
  async applyTextRuntimeProfile<T extends { provider?: string; model?: string; extra?: Record<string, unknown> }>(
    target: T,
    generation?: unknown,
  ): Promise<T> {
    const authored = readAgentReasoning(generation);
    const extra = authored ? reasoningExtra(authored) : await this.platformReasoningExtra();
    if (!extra) return target;

    const existing = isPlainObject(target.extra) ? target.extra : undefined;
    (target as { extra?: Record<string, unknown> }).extra = { ...extra, ...existing };
    return target;
  }

  /**
   * The PLATFORM tier of the reasoning cascade — what an agent that authored no posture
   * gets instead of the engine's own default.
   *
   * Three ways this yields nothing, and each is deliberate:
   *
   *  - the settings facade is unwired (`@Optional`, as it is in every positional test
   *    fixture and in a composition that reads no registry key). An unwired dependency is
   *    not a defect here, it is a graph that never reads this family — the same posture
   *    `EffectiveSettingsService` itself takes — so the call behaves exactly as it did
   *    before this tier existed;
   *  - the admin explicitly chose `engine-default`, which is the one state this ticket
   *    removed as an ACCIDENT and keeps available as a DECISION;
   *  - the resolve threw. A hyper-parameter must never fail a consultation, so the error is
   *    logged and the call proceeds — the same fail-open the two guardrail enrichments above
   *    take, and the reason this is not `failMode: 'closed'`.
   *
   * `resolve` under `resolveEffective` is a synchronous in-memory cache read, so this costs
   * nothing on the live flush path.
   */
  private async platformReasoningExtra(): Promise<Record<string, unknown> | undefined> {
    if (!this.effectiveSettings) return undefined;
    try {
      const resolved = await this.effectiveSettings.resolveEffective(TEXT_REASONING_DEFAULT_EFFORT_KEY, {
        tenantId: this.clsService.get('tenantId') ?? null,
        departmentId: null,
        doctorId: null,
      });
      const effort = resolved.value;
      if (typeof effort !== 'string' || !(TEXT_REASONING_DEFAULT_EFFORTS as readonly string[]).includes(effort)) {
        this.logger.warn({
          message: 'Platform default reasoning effort is not a declared member — leaving this call with no posture',
          key: TEXT_REASONING_DEFAULT_EFFORT_KEY,
          received: typeof effort === 'string' ? effort : typeof effort,
        });
        return undefined;
      }
      if (effort === TEXT_REASONING_ENGINE_DEFAULT) return undefined;
      return { [REASONING_EFFORT_EXTRA_KEY]: effort };
    } catch (error) {
      this.logger.warn({
        message: 'Platform default reasoning effort could not be resolved; forwarding without a posture',
        error: error instanceof Error ? error.message : String(error),
      });
      return undefined;
    }
  }
}

/**
 * The platform kill switch the disposition above reads. `globalOnly`, `maxScope: 'system'`,
 * `killSwitch: true` — a SYSTEM-tier value, never a tenant's (see
 * `text-provider-connections.descriptors.ts`). Typed against the descriptor key union so a
 * rename cannot leave a string literal pointing at a key that no longer exists.
 */
const PLATFORM_GUARDRAIL_SWITCH_KEY: TextGuardrailPostureKey = 'text.externalGuardrail.enabled';

/** A plain object, as the two guardrail merges above model one. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
