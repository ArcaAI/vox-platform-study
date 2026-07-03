import type { Tenant } from '@arcaai/vox';
import type { Department } from '@/features/tenants/sdk-types';
import { isSuperAdmin, isSystemTenant } from '@/features/tenants/permissions';
import { isAdminRole } from '@/lib/utils';
import { useAuthStore } from '@/store/auth-store';
import { useTenantDetailStore } from '@/store/tenant-detail-store';

export interface DepartmentScope {
  department: Department | null;
  tenant: Tenant | null;
  superAdmin: boolean;
  /** Write access: an admin role on a non-system tenant (mirrors the server CASL gate). */
  canManage: boolean;
}

/**
 * Shared tenant/department scope for the agent surfaces. The `$departmentId`
 * layout route fetches the department and publishes it (with the tenant) to the
 * tenant-detail store; every child page reads the same record from here, so there
 * is no prop-drilling or duplicate fetch (mirrors the existing TASK-379 pattern).
 */
export function useDepartmentScope(): DepartmentScope {
  const department = useTenantDetailStore((s) => s.department);
  const tenant = useTenantDetailStore((s) => s.tenant);
  const roles = useAuthStore((s) => s.user?.roles);
  return {
    department,
    tenant,
    superAdmin: isSuperAdmin(roles),
    canManage: !isSystemTenant(tenant) && isAdminRole(roles ?? undefined),
  };
}
