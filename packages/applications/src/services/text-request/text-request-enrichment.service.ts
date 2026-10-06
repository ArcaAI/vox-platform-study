import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { IActiveUserContext } from '../../interfaces';
import { IProviderConnectionService, ResolvedProviderOverrides } from '../ai-provider-connection/IProviderConnectionService';
import { isCloudByoProvider } from '../ai-provider-connection/constants';
import { assertProviderAvailable } from '../ai-provider-connection/assert-provider-available';
import { EffectiveSettingsService } from '../settings-registry/effective-settings.service';
import { TEXT_GUARDRAIL_POLICY_PUSH_FIELDS } from '../settings-registry/descriptors/text-guardrail-policy.descriptors';
import { REASONING_EFFORT_EXTRA_KEY, REASONING_WIRE_FIELD, readAgentReasoning, reasoningWire } from '../agent/agent-reasoning';
import type { AgentReasoning } from '../agent/agent-reasoning';
import {
  TEXT_REASONING_DEFAULT_EFFORTS,
  TEXT_REASONING_DEFAULT_EFFORT_KEY,
  textReasoningPlatformPosture,
} from '../settings-registry/descriptors/text-reasoning.descriptors';
import type { TextReasoningDefaultEffort } from '../settings-registry/descriptors/text-reasoning.descriptors';
import { KnownPhiService } from './known-phi.service';
import { stampProviderLocality, type ProviderLocalityHints } from './provider-locality';
import { ComposedPromptRecorder } from '../composed-prompt/composed-prompt.recorder';
import { createHash } from 'node:crypto';
import { IGovernedPromptRegistry } from '../governed-prompt/IGovernedPromptRegistry';
import type { GovernedPieceInput } from '../governed-prompt/IGovernedPromptRegistry';
import type { SystemGovernanceHint, SystemGovernanceWire } from './system-governance';

/**
 * What a caller knows about ONE outgoing `/generate` call that the egress statements need: the
 * model rows behind `provider` / `fallback_provider` (for `provider_locality`) and the consultation
 * the call is about (for `known_phi`). Everything is optional — an absent hint degrades to the
 * provider-name rule and to "the detector alone", never to an unscreened call.
 */
export interface TextEgressHints extends ProviderLocalityHints {
  /** The consultation this call generates for; its known PHI rides as `known_phi`. */
  consultationId?: string | null;
  /** The caller's own copy of the validated open context (kind key → payload), merged over the persisted one. */
  context?: Record<string, unknown> | null;
  /** Which generation this call is, for its composed-prompt record (`live`, `finalize`, `invoke`, …). */
  phase?: string;
  /** The agent whose instruction was composed, for its composed-prompt record. */
  agentSlug?: string | null;
  /**
   * TASK-1047 FC-4 — the composer's governance of the `system_prompt` it composed. Decides whether
   * `system_governance` rides this call (see {@link TextRequestEnrichmentService.applyEgressSafety}).
   */
  systemGovernance?: SystemGovernanceHint | null;
}

/** `guardrail_policy` keys a caller may no longer state: screening is not the caller's to switch off. */
const RETIRED_GUARDRAIL_POLICY_KEYS = ['enabled', 'require_medical', 'opted_out'] as const;

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
    // Backs `known_phi`. @Optional and trailing for the same reason as the two above; unwired, a
    // cloud call is pseudonymized by the text service's detector alone.
    @Optional()
    @Inject(KnownPhiService)
    private readonly knownPhi?: KnownPhiService,
    // The OD-9 composed-prompt record. @Optional and trailing for the same reason as the three
    // above; unwired, no record is kept and the call is otherwise unchanged.
    @Optional()
    @Inject(ComposedPromptRecorder)
    private readonly composedPrompts?: ComposedPromptRecorder,
    // TASK-1047 FC-4 — the governed-piece registry. @Optional and trailing for the same reason as
    // the four above; unwired, `system_governance` is NEVER sent, so every system prompt is
    // screened as untrusted — the safe direction.
    @Optional()
    @Inject(IGovernedPromptRegistry)
    private readonly governedPrompts?: IGovernedPromptRegistry,
  ) {}

  /**
   * The EGRESS statements on an outgoing `/generate` body. Runs inside
   * {@link applyTenantProviderOverrides}, so every caller that injects a credential — which the
   * coverage gate proves is every caller — states them too.
   *
   *   - `provider_locality` from the resolved model row (or the engine-served rule), REPLACING any
   *     client-supplied map: locality decides whether PHI is redacted, so it is never a client's
   *     to state. Unknown ⇒ omitted ⇒ `apps/text` treats the provider as cloud.
   *   - No guardrail opt-out survives: `guardrail_policy.enabled` / `require_medical` and
   *     `medical_exempt` are stripped (only an internal service caller may name itself exempt from
   *     the medical judge, and it never comes through the gateway). `include_reasoning` stays.
   *   - `known_phi` for the named consultation, FAIL-OPEN: a resolver failure sends none and the
   *     detector's span-level pass still runs. A client-supplied list is discarded.
   *   - `system_governance` (TASK-1047 FC-4) only from the composer's own governance, never from the
   *     body: a client-supplied value is discarded, and the field is attached only when the registry
   *     vouches for every piece of the system prompt actually on the body.
   */
  async applyEgressSafety<T extends object>(target: T, hints: TextEgressHints = {}): Promise<T> {
    const body = target as Record<string, unknown>;
    stampProviderLocality(body, hints);

    delete body.system_governance;
    await this.attachSystemGovernance(body, hints.systemGovernance ?? null);

    delete body.medical_exempt;
    if (isPlainObject(body.guardrail_policy)) {
      const policy = { ...body.guardrail_policy };
      for (const key of RETIRED_GUARDRAIL_POLICY_KEYS) delete policy[key];
      if (Object.keys(policy).length > 0) body.guardrail_policy = policy;
      else delete body.guardrail_policy;
    } else {
      delete body.guardrail_policy;
    }

    delete body.known_phi;
    if (hints.consultationId && this.knownPhi) {
      try {
        const entries = await this.knownPhi.forConsultation(hints.consultationId, hints.context ?? null);
        if (entries.length > 0) body.known_phi = entries;
      } catch (error) {
        // Never the values — only that the deterministic half is missing for this call.
        this.logger.warn({
          message: 'Known-PHI resolution failed; this call is pseudonymized by the detector alone (fail-open)',
          consultationId: hints.consultationId,
          error: error instanceof Error ? error.name : 'unknown',
        });
      }
    }
    this.recordComposedPrompt(body, hints);
    return target;
  }

  /**
   * TASK-1047 FC-4 — attach `system_governance` when, and only when, the system prompt on the body
   * is exactly the one the composer governed and every one of its pieces is registered PASS under
   * the current guardrail policy version. Every other outcome — no registry, no governance, a
   * changed system prompt, a "no", an unknown policy version, a registry error — omits the field,
   * and `apps/text` then screens the system prompt as untrusted data. Never throws.
   *
   * The PLATFORM / LANGUAGE / CONTRACT pieces the composer emitted are offered to the registry
   * first, fire-and-forget: registration screens in the background, so this call is unaffected and
   * a later one finds them governed.
   */
  private async attachSystemGovernance(body: Record<string, unknown>, hint: SystemGovernanceHint | null): Promise<void> {
    const registry = this.governedPrompts;
    if (!hint || !registry) return;
    // The REQUEST tenant: guardrail's policy version — and so every verdict — is per tenant.
    const tenantId = hint.tenantId ?? this.clsService.get('tenantId') ?? undefined;
    if (hint.platformPieces && hint.platformPieces.length > 0) this.registerPlatformPieces(registry, hint.platformPieces, tenantId);

    const governance = hint.governance;
    const system = body.system_prompt;
    if (!governance || typeof system !== 'string' || system.length === 0) return;
    if (createHash('sha256').update(system, 'utf8').digest('hex') !== governance.composedDigest) {
      // The composed system was changed after composing — it is no longer what the pieces vouch for.
      this.logger.warn({ message: 'system_prompt differs from its composed digest; screening it as untrusted', composedDigest: governance.composedDigest });
      return;
    }
    if (!tenantId) return;
    try {
      const governed = await registry.areGoverned(
        tenantId,
        governance.pieces.map((piece) => piece.digest),
      );
      if (!governed) return;
      const policyVersion = await registry.currentPolicyVersion(tenantId);
      if (!policyVersion) return;
      const wire: SystemGovernanceWire = {
        composed_digest: governance.composedDigest,
        pieces: governance.pieces.map(({ kind, key, digest }) => ({ kind, key, digest })),
        policy_version: policyVersion,
      };
      body.system_governance = wire;
    } catch (error) {
      // Digests and the error class only — never the prompt.
      this.logger.warn({
        message: 'Governed-prompt lookup failed; the system prompt is screened as untrusted for this call',
        composedDigest: governance.composedDigest,
        error: error instanceof Error ? error.name : 'unknown',
      });
    }
  }

  /** Fire-and-forget platform-piece registration: neither a rejection nor a throw reaches the call. */
  private registerPlatformPieces(registry: IGovernedPromptRegistry, pieces: readonly GovernedPieceInput[], tenantId: string | undefined): void {
    const report = (error: unknown) =>
      this.logger.warn({
        message: 'Platform prompt-piece registration failed; those pieces stay ungoverned until a later call registers them',
        pieces: pieces.length,
        error: error instanceof Error ? error.name : 'unknown',
      });
    try {
      void Promise.resolve(registry.registerPlatformPieces(pieces, tenantId)).catch(report);
    } catch (error) {
      report(error);
    }
  }

  /**
   * The OD-9 incident record of THIS call's composed messages — fire-and-forget, so it can never
   * fail or slow the call. Every gateway → TEXT call passes here, which is what makes this the one
   * writer for the gateway's call sites. A body with no prompt at all (a credential probe) is not
   * a generation and is not recorded; nor is a call with no tenant to own the record.
   */
  private recordComposedPrompt(body: Record<string, unknown>, hints: TextEgressHints): void {
    if (!this.composedPrompts) return;
    const system = typeof body.system_prompt === 'string' ? body.system_prompt : '';
    const user = typeof body.prompt === 'string' ? body.prompt : '';
    if (system.length === 0 && user.length === 0) return;
    const tenantId = this.clsService.get('tenantId');
    if (!tenantId) return;
    const provider = typeof body.provider === 'string' ? body.provider : '';
    const localities = isPlainObject(body.provider_locality) ? body.provider_locality : {};
    const context = isPlainObject(body.context) ? body.context : {};
    this.composedPrompts.record({
      tenantId,
      consultationId: hints.consultationId ?? null,
      agentSlug: hints.agentSlug ?? (typeof context.agentSlug === 'string' ? context.agentSlug : null),
      phase: hints.phase ?? (hints.consultationId ? 'consultation' : 'generate'),
      provider,
      // An unstamped provider is CLOUD to `apps/text` (fail closed), so it is recorded as such.
      locality: localities[provider] === 'local' ? 'local' : 'cloud',
      system,
      user,
    });
  }

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
  async applyTenantProviderOverrides<T extends { provider?: string; provider_overrides?: unknown }>(target: T, egress: TextEgressHints = {}): Promise<T> {
    // The egress statements first, and unconditionally: every early return below must still carry them.
    await this.applyEgressSafety(target, egress);
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
   * Why this field and no other: `include_reasoning` is the one part of the posture that
   * legitimately differs BETWEEN tenants. `require_medical` used to be pushed too; the medical
   * judge now runs on every business-plane call (owner decisions OD-3 / OD-5), so it is never
   * sent. The rest (the retry budget) are platform capacity decisions and travel the PULL
   * channel instead, and the FAIL POSTURE travels neither: an errored guardrail can never allow.
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
      // MERGED, never assigned: a caller may already carry other `guardrail_policy` fields.
      const record = target as Record<string, unknown>;
      const existing = isPlainObject(record.guardrail_policy) ? record.guardrail_policy : {};
      record.guardrail_policy = { ...existing, ...policy };
    }
    return target;
  }

  /**
   * State this call's REASONING POSTURE on an outbound `/api/v1/generate` body, as
   * `GenerateRequest.reasoning`.
   *
   * ## What changed in TASK-970, and what did not
   *
   * TASK-891 C2 put the agent's `parameters.generation.reasoning` on the wire by
   * PRE-RENDERING it into `extra.reasoning_effort` — OpenAI's parameter, sent to every
   * engine. That was lossy (`enabled: false` became `'minimal'`, which an engine cannot
   * distinguish from a request for minimal EFFORT) and, worse, unreachable: seven of the ten
   * adapters never read `extra` at all, so an admin who turned reasoning off on an Ollama- or
   * Anthropic-bound agent got a silent no-op and a bill for reasoning tokens.
   *
   * The posture therefore travels AS a posture and each adapter renders it into its own
   * engine's vocabulary — the `ResolvedAsrSpec` split of TASK-861 applied to generation. The
   * written contract is `tests/contracts/reasoning-posture.fixture.json`; both halves are
   * pinned to it (`tests/contracts/reasoning-posture-parity.contract.test.ts` here).
   *
   * What did NOT change is the CASCADE. Both tiers, in the same order, with the same
   * widening rule.
   *
   * ## The cascade (TASK-968, unchanged)
   *
   *     the agent's authored block  →  the platform default  →  nothing
   *
   * It fills ABSENCE ONLY. An agent that authored `{ enabled: true }` with no effort is an
   * OPINION: the platform tier is not consulted for it, exactly as before. The one visible
   * difference is that the opinion now REACHES the wire as `{ enabled: true }` instead of
   * being flattened to silence — TASK-891 had no way to say "on, budget unnamed", so it said
   * nothing, which on the wire was indistinguishable from an agent that had no view at all.
   * Which tier wins is untouched; what the winner can express is not.
   *
   * ## Merge rules — the CALLER still WINS
   *
   * A call site that pinned `extra.reasoning_effort` has decided about this specific request
   * and is not second-guessed (the contract's `wire.caller_override`), nor is one that stated
   * `reasoning` itself. Note the shape of that deference changed with the field: where this
   * used to merge per key, it now emits NOTHING at all when the caller pinned the ride-along.
   * It has to. On an `effort-only` adapter a rendered posture and the raw pin land on the
   * SAME engine parameter, so shipping both would make an ordering accident decide whether
   * the caller's pin survived — which is the opposite of deferring to it.
   */
  async applyTextRuntimeProfile<T extends { provider?: string; model?: string; extra?: Record<string, unknown>; reasoning?: AgentReasoning }>(
    target: T,
    generation?: unknown,
  ): Promise<T> {
    if (this.callerPinnedReasoning(target)) return target;

    const authored = readAgentReasoning(generation);
    const posture = authored ?? (await this.platformReasoningPosture());
    const wire = reasoningWire(posture);
    if (!wire) return target;

    (target as Record<string, unknown>)[REASONING_WIRE_FIELD] = wire;
    return target;
  }

  /**
   * Has this call site already spoken for itself about reasoning?
   *
   * Two ways it can have: the posture field, or the raw `extra.reasoning_effort` ride-along
   * that TASK-891 used and that the contract keeps supported for exactly this reason. Either
   * one ends the enrichment — see the merge-rules note above for why the ride-along cannot
   * merely be merged around.
   */
  private callerPinnedReasoning(target: { extra?: Record<string, unknown>; reasoning?: AgentReasoning }): boolean {
    if (target.reasoning !== undefined) return true;
    return isPlainObject(target.extra) && target.extra[REASONING_EFFORT_EXTRA_KEY] !== undefined;
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
   *    logged and the call proceeds — the same fail-open the guardrail-policy enrichment above
   *    takes, and the reason this is not `failMode: 'closed'`.
   *
   * `resolve` under `resolveEffective` is a synchronous in-memory cache read, so this costs
   * nothing on the live flush path.
   */
  private async platformReasoningPosture(): Promise<AgentReasoning | null> {
    if (!this.effectiveSettings) return null;
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
        return null;
      }
      // The enum → posture mapping lives beside the descriptor that declares the enum, so the
      // two vocabularies meet in exactly one place (`textReasoningPlatformPosture`).
      return textReasoningPlatformPosture(effort as TextReasoningDefaultEffort);
    } catch (error) {
      this.logger.warn({
        message: 'Platform default reasoning effort could not be resolved; forwarding without a posture',
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }
}

/** A plain object, as the guardrail-policy merges above model one. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
