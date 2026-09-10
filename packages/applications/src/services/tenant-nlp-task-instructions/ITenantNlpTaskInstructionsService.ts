import { TenantNlpTaskInstructionsResponse, UpsertTenantNlpTaskInstructionsRequest } from './dto';

/**
 * Tenant-writable topic/intent instruction content service.
 *
 * `tenantId` is optional on every method: when omitted the CLS request
 * tenant is used; a super admin may target another tenant explicitly (the
 * controller resolves `?tenantId=` via `resolveScopedTenantId`). Unlike
 * `AiRoutingPolicy` there is no SYSTEM-tenant platform default and no
 * super-admin-only write lock — an ordinary tenant admin owns these rows.
 */
export interface ITenantNlpTaskInstructionsService {
  /** Raw persisted row for (tenant, taskKey) — version:0 placeholder when none. */
  getRow(taskKey: string, tenantId?: string): Promise<TenantNlpTaskInstructionsResponse>;

  /**
   * Create (expectedVersion 0) or compare-and-set the (tenant, taskKey) row.
   * `taskKey` must be `nlp.topic` or `nlp.intent` — any other value throws
   * `ArgumentInvalidException`.
   */
  upsertRow(taskKey: string, dto: UpsertTenantNlpTaskInstructionsRequest, tenantId?: string): Promise<TenantNlpTaskInstructionsResponse>;
}

export const ITenantNlpTaskInstructionsService = Symbol('ITenantNlpTaskInstructionsService');
