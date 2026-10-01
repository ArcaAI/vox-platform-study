/**
 * In-process event a gateway node emits when a tenant's restore lock has been released
 * (payload `{ tenantId }`). A restore rewrites configuration rows from another process, so
 * every in-process cache over those tables drops the tenant's entries on this event.
 */
export const TENANT_RESTORE_COMPLETED_EVENT = 'tenant-restore.completed' as const;

export interface TenantRestoreCompletedPayload {
  tenantId: string;
}
