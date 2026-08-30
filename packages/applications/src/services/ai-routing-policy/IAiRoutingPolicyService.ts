import { AiRoutingPolicyResponse, CreateAiRoutingPolicyRequest, EffectiveRoutingPolicyResponse, UpdateAiRoutingPolicyRequest } from './dto';
import { RoutingRequestContext } from './routing-policy.contract';

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
 * The provider ROUTING POLICY plane (TASK-818 §3A).
 *
 * WHICH candidates serve a task, in what order, and what may happen when the
 * first one fails. Sits above `AiProviderConnection` (where a provider lives +
 * how to authenticate), `AiTaskDefault` (one default model per task) and
 * `AiRuntimeProfile` (hyperparameters) — it is the ordered N-way chain over
 * those that did not previously exist.
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

  /** One revision by id. A row outside `tenantId` is a 404, never a 403. */
  getById(id: string, tenantId: string): Promise<AiRoutingPolicyResponse>;

  /**
   * Resolve what actually serves `(tenantId, taskKey)` right now: the winning
   * policy, its primary candidate, the ALREADY-GATED fallback chain, every
   * candidate the §3A.4 gates refused with its reason, and a machine-readable
   * rejection when nothing may serve.
   */
  getEffective(tenantId: string, taskKey: string, options?: ResolveRoutingOptions): Promise<EffectiveRoutingPolicyResponse>;

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
