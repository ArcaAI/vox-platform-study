/** Raised when work for a tenant is attempted while a restore holds the tenant's lock. */
export class TenantLockedError extends Error {
  constructor(
    readonly tenantId: string,
    readonly restoreId?: string,
  ) {
    super(`Tenant ${tenantId} is locked by a restore in progress`);
    this.name = 'TenantLockedError';
  }
}
