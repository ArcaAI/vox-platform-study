import { AiTaskDefaultResponse, AiTaskModelSummary, EffectiveAiTaskDefaultResponse, UpsertAiTaskDefaultRequest } from './dto';

/**
 * @deprecated TASK-862 — removed in R3. This is a FACADE over
 * `IAiRoutingPolicyService.resolveDefault` (reads) and the elected
 * `AiRoutingPolicy` row (writes); the `AiTaskDefault` table is no longer read
 * or written. New code injects `IAiRoutingPolicyService`.
 *
 * Per-tenant AI task-model default service.
 *
 * `tenantId` is optional on every method: when omitted the CLS request tenant
 * is used; a super admin may target another tenant explicitly (the controller
 * resolves `?tenantId=` via `resolveScopedTenantId`). The reserved SYSTEM
 * tenant id addresses the platform-default row.
 */
export interface IAiTaskDefaultService {
  /**
   * Resolved default for a task: tenant row → SYSTEM row → null (consuming
   * service env fallback). Includes the resolved ENABLED `AiModel` summary
   * ([tenant, SYSTEM] preferring tenant) when the slug resolves.
   */
  /**
   * @throws TaskSelectionVetoedError (503) when the tenant has DISABLED its own
   * elected routing configuration for `taskKey` — the facade propagates the
   * veto rather than projecting it as an unconfigured selection (TASK-872).
   */
  getEffective(taskKey: string, tenantId?: string): Promise<EffectiveAiTaskDefaultResponse>;

  /**
   *  — resolve a bare `AiModel.slug` through the SAME
   * `[tenant, SYSTEM]` ENABLED-model lookup `getEffective` uses for the slug on
   * an `AiTaskDefault` row, preferring the tenant's own row.
   *
   * Exposed so a workflow node's `llmBinding.modelSlug` reaches ONE model
   * resolution rather than a second copy of it: the tenant → SYSTEM preference,
   * the ENABLED pin and the cross-tenant read lane all live in the private
   * `resolveEnabledModelBySlug` this delegates to, and a caller that
   * reimplemented them would drift on the first one that changed.
   *
   * Deliberately does NOT take a task key, and therefore performs NO
   * `taskType` compatibility check: that check belongs to a WRITE
   * (`upsertRow`), which is where a mismatch can still be refused with the
   * offending value in hand. A runtime READ that silently dropped a bound model
   * for a task-type mismatch would be a fail-OPEN substitution — the caller
   * fails closed on `null` instead.
   *
   * `null` — never a throw — when the slug resolves to no ENABLED model in
   * either tier. What that means is the CALLER's decision, exactly as it is for
   * `getEffective`.
   */
  resolveModelBySlug(modelSlug: string, tenantId?: string): Promise<AiTaskModelSummary | null>;

  /** Raw persisted row for (tenant, taskKey) — version:0 placeholder when none. */
  getRow(taskKey: string, tenantId?: string): Promise<AiTaskDefaultResponse>;

  /**
   * Create (expectedVersion 0) or compare-and-set the (tenant, taskKey) row.
   * `nlp.*`/`harness.*` keys are SUPER_ADMIN-ONLY (ForbiddenException for
   * tenant admins — a privilege rule, not a cross-tenant probe). `guardrail.*`
   * is tenant-admin configurable since, but a tenant write
   * still must name a slug on the platform-approved model list (a
   * SYSTEM-tenant `AiModel` row) — also a `ForbiddenException`, not the
   * generic slug-resolution `ArgumentInvalidException`.
   */
  upsertRow(taskKey: string, dto: UpsertAiTaskDefaultRequest, tenantId?: string): Promise<AiTaskDefaultResponse>;
}

export const IAiTaskDefaultService = Symbol('IAiTaskDefaultService');
