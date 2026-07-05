import type { TenantPlan } from '@/features/tenants/api/types';

export const entitlementKeys = {
    root: ['entitlements'] as const,
    enabled: () => [...entitlementKeys.root, 'enabled'] as const,
    plans: () => [...entitlementKeys.root, 'plans'] as const,
    plan: (plan: TenantPlan) => [...entitlementKeys.root, 'plans', plan] as const,
    tenant: (tenantId: string) => [...entitlementKeys.root, 'tenant', tenantId] as const,
    override: (tenantId: string) => [...entitlementKeys.root, 'override', tenantId] as const,
    me: () => [...entitlementKeys.root, 'me'] as const,
};
