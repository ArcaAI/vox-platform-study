import { create } from 'zustand';
import type { Tenant, User } from '@arcaai/vox';
import type { Department } from '@/features/tenants/sdk-types';

/**
 * The tenant (and department / user) currently being viewed under
 * `/tenants/$tenantId/*`. The `$tenantId` / `$departmentId` / `$userId` layout
 * routes fetch via the SDK and publish here so the topbar breadcrumb (rendered by
 * the shell, a *parent* of the detail routes) and the tab pages can read the same
 * record without a route loader or prop-drilling. Cleared when leaving the
 * tenant-detail surface.
 */
interface TenantDetailState {
    tenant: Tenant | null;
    department: Department | null;
    user: User | null;
    setTenant: (tenant: Tenant | null) => void;
    setDepartment: (department: Department | null) => void;
    setUser: (user: User | null) => void;
    clear: () => void;
}

export const useTenantDetailStore = create<TenantDetailState>((set) => ({
    tenant: null,
    department: null,
    user: null,
    setTenant: (tenant) => set({ tenant }),
    setDepartment: (department) => set({ department }),
    setUser: (user) => set({ user }),
    clear: () => set({ tenant: null, department: null, user: null }),
}));
