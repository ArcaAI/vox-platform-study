import { AiTaskDefaultResponse, EffectiveAiTaskDefaultResponse, UpsertAiTaskDefaultRequest } from './dto';

/**
 * Per-tenant AI task-model default service.
 *
 * `tenantId` is optional on every method: when omitted the CLS request tenant
 * is used; a global admin may target another tenant explicitly (the controller
 * resolves `?tenantId=` via `resolveScopedTenantId`). The reserved SYSTEM
 * tenant id addresses the platform-default row.
 */
export interface IAiTaskDefaultService {
  /**
   * Resolved default for a task: tenant row → SYSTEM row → null (consuming
   * service env fallback). Includes the resolved ENABLED `AiModel` summary
   * ([tenant, SYSTEM] preferring tenant) when the slug resolves.
   */
  getEffective(taskKey: string, tenantId?: string): Promise<EffectiveAiTaskDefaultResponse>;

  /** Raw persisted row for (tenant, taskKey) — version:0 placeholder when none. */
  getRow(taskKey: string, tenantId?: string): Promise<AiTaskDefaultResponse>;

  /**
   * Create (expectedVersion 0) or compare-and-set the (tenant, taskKey) row.
   * `guardrail.*` keys are GLOBAL-ADMIN-ONLY (ForbiddenException for tenant
   * admins — a privilege rule, not a cross-tenant probe).
   */
  upsertRow(taskKey: string, dto: UpsertAiTaskDefaultRequest, tenantId?: string): Promise<AiTaskDefaultResponse>;
}

export const IAiTaskDefaultService = Symbol('IAiTaskDefaultService');
