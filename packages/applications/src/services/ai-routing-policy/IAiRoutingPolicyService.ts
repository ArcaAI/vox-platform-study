import { AiRoutingPolicyResponse, CreateAiRoutingPolicyRequest, EffectiveRoutingPolicyResponse, UpdateAiRoutingPolicyRequest } from './dto';
import { RoutingRequestContext } from './routing-policy.contract';
import { ProviderConfigurationExport } from './provider-configuration';

/** What a caller may tell the resolver about the request it is routing. */
export interface ResolveRoutingOptions extends RoutingRequestContext {
  /**
   * A provider the CALLER named explicitly. Under the default
   * `explicitProvider.mode = STRICT` this closes the fallback chain outright:
   * if the named provider cannot serve, the answer is a `provider_unavailable`
   * rejection, never a substitution (§3A.4).
   */
  explicitProvider?: string | null;
  /**
   * Per-request opt-in to fallbacks, honoured ONLY under
   * `STRICT_UNLESS_OPTED_IN`. It can never widen the three hard gates.
   */
  allowFallbacks?: boolean;
  /**
   * The router's live circuit view — providers it has ejected (§3A.5). Health
   * is MEASURED where the calls are made, so it is supplied here rather than
   * re-derived; without it a candidate is judged available whenever its
   * credential resolves.
   */
  unhealthyProviders?: string[];
}

/**
 * TASK-847 finding F-32 — a workflow node's `providerConfigRef`, as the routing plane sees it.
 *
 * Exactly one field is meaningful, which is the node schema's own rule (`agenticNodeConfigProblems`
 * enforces it at authoring time). Both are optional here because this type describes what a caller
 * READ off a graph, and a graph that failed that rule must still get an answer rather than a throw.
 */
export interface GenerationCapabilitySelector {
  readonly routingPolicyId?: string | null;
  readonly taskKey?: string | null;
}

/** What the resolved provider configuration says about generation tuning. */
export interface ResolvedGenerationCapabilities {
  /**
   * How to NAME the configuration in an author-facing message — the display name, else
   * `taskKey (revision N)`, with the resolved model slug appended. Falls back to naming the
   * unresolved reference itself, so a message is always actionable.
   */
  readonly label: string;
  /**
   * The declared set, or `undefined` when nothing declared one.
   *
   * `undefined` is UNKNOWN and NOT "supports nothing" — the distinction is the whole severity
   * split in `hyperparameterCapabilityProblems`, and collapsing it would turn every unprofiled
   * configuration into a publish-blocking error.
   */
  readonly supportedGenerationParams?: readonly string[];
}

/**
 * The provider ROUTING POLICY plane (TASK-818 §3A).
 *
 * WHICH candidates serve a task, in what order, which one is the elected
 * default, and what may happen when the first one fails.
 *
 * ## TASK-844 (OD-3) — this plane ABSORBED `AiTaskDefault`
 *
 * One row is ONE PROVIDER CONFIGURATION for one `(tenant, taskKey)`: a real FK
 * to `AiProviderConnection` (where a provider lives + how to authenticate) and
 * a real FK to `AiModel` (the catalogue). Many rows may exist per selection;
 * they form the ordered chain, and EXACTLY ONE may carry `isDefault` — enforced
 * by a partial unique index in the database, keyed on `taskKey` and NOT
 * `taskKind` (F-26). `AiRuntimeProfile` (hyperparameters) still sits alongside.
 *
 * OD-3 explicitly reverses TASK-816's ruling that `AiTaskDefault` survives.
 *
 * ## Two audiences, two rules
 *
 * WRITES are SUPER-ADMIN-ONLY, enforced imperatively (403). The owner
 * requirement is that "default routing and failover policies MUST be managed by
 * the platform super admin"; a tenant expresses itself through its own
 * `AiProviderConnection` rows (BYO keys) and through a tenant-scoped policy row
 * a super admin authors on its behalf.
 *
 * READS resolve tenant → SYSTEM, TWO tiers. `50000000-…` ("Global") is a
 * CUSTOMER tenant — the platform-admin playground — and never appears in the
 * cascade at any point.
 */
export interface IAiRoutingPolicyService {
  /** Every revision owned by one tenant, newest authored revision first. */
  list(tenantId: string, taskKey?: string): Promise<AiRoutingPolicyResponse[]>;

  /**
   * TASK-844 — ELECT this configuration as the default for its
   * `(tenant, taskKey)`.
   *
   * ATOMIC: the incumbent is unset and the successor set inside ONE
   * transaction, so the selection is never left without a default — which
   * matters because selection is `failMode: closed`, so that window would be an
   * outage rather than a degraded state. The partial unique index is what makes
   * concurrent elections safe: one commits, the other is refused by the
   * database.
   *
   * Idempotent — re-electing the current default returns 200 and writes nothing.
   */
  setDefault(id: string, tenantId: string, expectedVersion?: number): Promise<AiRoutingPolicyResponse>;

  /**
   * TASK-844 — COPY a configuration from one tenant to another the actor also
   * administers.
   *
   * **No credential is copied.** The copy re-points at the TARGET tenant's own
   * connection for the same `(service, provider)` through the standard cascade;
   * a target with no such row lands with a NULL connection and must supply one
   * (or inherit SYSTEM's). It always lands DRAFT and NOT default, because
   * promotion offers a configuration — it does not switch a tenant's traffic.
   */
  promote(id: string, sourceTenantId: string, targetTenantId: string): Promise<AiRoutingPolicyResponse>;

  /**
   * TASK-844 — EXPORT configurations as portable JSON.
   *
   * The artifact carries NO credential material and no characters of any key —
   * only a `credentialRef` LOCATOR naming which secret an importing operator
   * must supply. Enforced at runtime by `assertNoSecretMaterial` over the
   * finished structure, and asserted by test.
   */
  exportConfigurations(tenantId: string, taskKeys?: string[]): Promise<ProviderConfigurationExport>;

  /**
   * TASK-844 — IMPORT an artifact into a tenant.
   *
   * Rows land DRAFT and NOT default. Models are matched by SLUG on the two-tier
   * cascade (a slug that resolves to nothing is SKIPPED, never guessed);
   * connections are matched by `(service, provider)` against the target's own
   * rows. `requiresCredential` reports the locators the operator still has to
   * supply, so a missing key is stated at import time rather than discovered as
   * a 503.
   */
  importConfigurations(
    tenantId: string,
    artifact: ProviderConfigurationExport,
  ): Promise<{ imported: number; skipped: number; requiresCredential: string[] }>;

  /** One revision by id. A row outside `tenantId` is a 404, never a 403. */
  getById(id: string, tenantId: string): Promise<AiRoutingPolicyResponse>;

  /**
   * Resolve what actually serves `(tenantId, taskKey)` right now: the winning
   * policy, its primary candidate, the ALREADY-GATED fallback chain, every
   * candidate the §3A.4 gates refused with its reason, and a machine-readable
   * rejection when nothing may serve.
   */
  getEffective(tenantId: string, taskKey: string, options?: ResolveRoutingOptions): Promise<EffectiveRoutingPolicyResponse>;

  /**
   * TASK-847 finding F-32 — which generation hyper-parameters the configuration a node binds to
   * accepts, for the workflow publish gate.
   *
   * Resolves through the SAME two-tier cascade as everything else on this plane, and never
   * throws: an unresolvable reference answers `supportedGenerationParams: undefined` (UNKNOWN),
   * because a capability question must not be what fails a publish.
   */
  resolveGenerationCapabilities(tenantId: string, selector: GenerationCapabilitySelector): Promise<ResolvedGenerationCapabilities>;

  /** Author a new DRAFT revision. SUPER_ADMIN only. */
  create(tenantId: string, dto: CreateAiRoutingPolicyRequest): Promise<AiRoutingPolicyResponse>;

  /**
   * Compare-and-set an existing revision. SUPER_ADMIN only. A DRAFT is fully
   * editable; an ACTIVE or ARCHIVED revision accepts `killSwitch` alone, so a
   * rollback target can never be rewritten under the auditor's feet (§3A.8).
   */
  update(id: string, tenantId: string, dto: UpdateAiRoutingPolicyRequest): Promise<AiRoutingPolicyResponse>;

  /**
   * Promote a DRAFT to ACTIVE, archiving the revision it supersedes and
   * stamping `supersedesVersion` + `activatedAt`. SUPER_ADMIN only. This is the
   * moment PHI may start reaching a different vendor, so it is a transition of
   * its own rather than a `status` field on an update body.
   */
  activate(id: string, tenantId: string, expectedVersion?: number): Promise<AiRoutingPolicyResponse>;

  /** Soft-delete a revision. SUPER_ADMIN only. */
  deleteById(id: string, tenantId: string): Promise<AiRoutingPolicyResponse>;
}

export const IAiRoutingPolicyService = Symbol('IAiRoutingPolicyService');
