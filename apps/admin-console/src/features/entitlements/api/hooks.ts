'use client';

import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { TenantPlan } from '@/features/tenants/api/types';
import {
  clearTenantOverride,
  getEnforcementEnabled,
  getPlanEntitlement,
  getTenantEntitlements,
  getTenantOverride,
  listPlanEntitlements,
  runTrialExpiry,
  setEnforcementEnabled,
  triggerDowngrade,
  updatePlanEntitlement,
  upsertTenantOverride,
} from './client';
import { entitlementKeys } from './keys';
import type { UpdatePlanEntitlementRequest, UpsertTenantEntitlementRequest } from './types';

export function useEnforcementEnabled() {
  return useQuery({ queryKey: entitlementKeys.enabled(), queryFn: getEnforcementEnabled });
}

export function usePlanEntitlements() {
  return useQuery({ queryKey: entitlementKeys.plans(), queryFn: listPlanEntitlements });
}

export function usePlanEntitlement(plan: TenantPlan) {
  return useQuery({ queryKey: entitlementKeys.plan(plan), queryFn: () => getPlanEntitlement(plan) });
}

export function useTenantEntitlements(tenantId: string) {
  return useQuery({ queryKey: entitlementKeys.tenant(tenantId), queryFn: () => getTenantEntitlements(tenantId), enabled: !!tenantId });
}

export function useTenantOverride(tenantId: string) {
  return useQuery({ queryKey: entitlementKeys.override(tenantId), queryFn: () => getTenantOverride(tenantId), enabled: !!tenantId });
}

function useInvalidateEntitlements() {
  const queryClient = useQueryClient();
  return () => queryClient.invalidateQueries({ queryKey: entitlementKeys.root });
}

export function useSetEnforcementEnabled() {
  const invalidate = useInvalidateEntitlements();
  return useMutation({ mutationFn: (enabled: boolean) => setEnforcementEnabled(enabled), onSuccess: invalidate });
}

export function useUpdatePlanEntitlement() {
  const invalidate = useInvalidateEntitlements();
  return useMutation({
    mutationFn: ({ plan, body }: { plan: TenantPlan; body: UpdatePlanEntitlementRequest }) => updatePlanEntitlement(plan, body),
    onSuccess: invalidate,
  });
}

export function useUpsertTenantOverride() {
  const invalidate = useInvalidateEntitlements();
  return useMutation({
    mutationFn: ({ tenantId, body }: { tenantId: string; body: UpsertTenantEntitlementRequest }) => upsertTenantOverride(tenantId, body),
    onSuccess: invalidate,
  });
}

export function useClearTenantOverride() {
  const invalidate = useInvalidateEntitlements();
  return useMutation({ mutationFn: (tenantId: string) => clearTenantOverride(tenantId), onSuccess: invalidate });
}

export function useTriggerDowngrade() {
  const invalidate = useInvalidateEntitlements();
  return useMutation({
    mutationFn: ({ tenantId, plan }: { tenantId: string; plan: TenantPlan }) => triggerDowngrade(tenantId, plan),
    onSuccess: invalidate,
  });
}

export function useRunTrialExpiry() {
  const invalidate = useInvalidateEntitlements();
  return useMutation({ mutationFn: () => runTrialExpiry(), onSuccess: invalidate });
}
