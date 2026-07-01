import { StatusBadge, type StatusColorRole } from '@arcaai/ui/components/shared';
import type { Tenant } from '@arcaai/vox';
import { cn } from '@/lib/utils';

/**
 * Tenant commercial plan (TASK-387 #3). DISPLAY + set-enum only — the badge and
 * selector surface the tier; no entitlement / feature-gating is attached (plan
 * semantics are a separate, pending product decision).
 *
 * Derived from the exported `Tenant['plan']` (the SDK declares the `TenantPlan`
 * alias on the hook but does not re-export it from the package barrel).
 */
export type TenantPlan = NonNullable<Tenant['plan']>;

export const TENANT_PLAN_VALUES: readonly TenantPlan[] = ['ENTERPRISE', 'PRO', 'TRIAL', 'STARTER'];

const PLAN_LABEL: Record<TenantPlan, string> = {
    ENTERPRISE: 'Enterprise',
    PRO: 'Pro',
    TRIAL: 'Trial',
    STARTER: 'Starter',
};

const PLAN_ROLE: Record<TenantPlan, StatusColorRole> = {
    ENTERPRISE: 'hope',
    PRO: 'info',
    TRIAL: 'warning',
    STARTER: 'neutral',
};

/** Human label for a plan; `null`/unset reads as an em-dash. */
export function planLabel(plan?: TenantPlan | null): string {
    return plan ? PLAN_LABEL[plan] : '—';
}

export function planBadgeRole(plan?: TenantPlan | null): StatusColorRole {
    return plan ? PLAN_ROLE[plan] : 'neutral';
}

/**
 * Plan badge for the tenant list + detail. An unset plan (`null`) reads as a
 * muted em-dash (never a fabricated tier); an assigned plan is a colored pill.
 */
export function TenantPlanBadge({ plan, className }: { plan?: TenantPlan | null; className?: string }) {
    if (!plan) return <span className={cn('text-sm text-muted-foreground', className)}>—</span>;
    return <StatusBadge label={planLabel(plan)} colorRole={planBadgeRole(plan)} className={className} />;
}
