import { Badge } from '@arcaai/ui/components/shadcn/badge';
import type { FilterOption } from '@/shared/data/filter-bar';
import type { TenantPlan } from '../api/types';

export const PLAN_LABELS: Record<TenantPlan, string> = {
  ENTERPRISE: 'Enterprise',
  PRO: 'Pro',
  STARTER: 'Starter',
  TRIAL: 'Trial',
};

export const PLAN_FILTER_OPTIONS: FilterOption[] = (Object.keys(PLAN_LABELS) as TenantPlan[]).map((plan) => ({
  value: plan,
  label: PLAN_LABELS[plan],
}));

/** Plan chip per frame 12; tenants without a commercial plan show a dash. */
export function TenantPlanBadge({ plan }: { plan: TenantPlan | null | undefined }) {
  if (!plan) return <span className="text-muted-foreground">{'\u2014'}</span>;
  return <Badge variant="secondary">{PLAN_LABELS[plan]}</Badge>;
}
