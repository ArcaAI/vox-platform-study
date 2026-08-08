'use client';

import { useQuery } from '@tanstack/react-query';

import { getCostPerEncounter, getTopTenants, getUsageSummary } from './client';
import { consumptionKeys } from './keys';
import type { CostPerEncounterResponse, TopTenantsResponse, UsagePeriodParams, UsageSummaryResponse } from './types';

/**
 * TanStack Query hooks for the Consumption & Cost screen (TASK-615 #15a).
 * Each returns a thin view-model (`isPending`/`error`/`refetch`/`data`) so the
 * screen never dereferences `undefined`. `enabled` gates the tenant-scoped reads
 * until a working tenant is selected (WorkingTenantGate).
 */

export interface UsageSummaryView {
  isPending: boolean;
  error: Error | null;
  refetch: () => void;
  data: UsageSummaryResponse | null;
}

export function useUsageSummary(enabled: boolean, params?: UsagePeriodParams): UsageSummaryView {
  const query = useQuery({
    queryKey: consumptionKeys.summary(params),
    queryFn: () => getUsageSummary(params),
    enabled,
  });
  return {
    isPending: query.isPending,
    error: (query.error as Error | null) ?? null,
    refetch: () => void query.refetch(),
    data: query.data ?? null,
  };
}

export interface CostPerEncounterView {
  isPending: boolean;
  error: Error | null;
  refetch: () => void;
  data: CostPerEncounterResponse | null;
}

export function useCostPerEncounter(enabled: boolean, params?: UsagePeriodParams): CostPerEncounterView {
  const query = useQuery({
    queryKey: consumptionKeys.costPerEncounter(params),
    queryFn: () => getCostPerEncounter(params),
    enabled,
  });
  return {
    isPending: query.isPending,
    error: (query.error as Error | null) ?? null,
    refetch: () => void query.refetch(),
    data: query.data ?? null,
  };
}

export interface TopTenantsView {
  isPending: boolean;
  error: Error | null;
  refetch: () => void;
  data: TopTenantsResponse | null;
}

export function useTopTenants(enabled: boolean, params?: UsagePeriodParams): TopTenantsView {
  const query = useQuery({
    queryKey: consumptionKeys.topTenants(params),
    queryFn: () => getTopTenants(params),
    enabled,
  });
  return {
    isPending: query.isPending,
    error: (query.error as Error | null) ?? null,
    refetch: () => void query.refetch(),
    data: query.data ?? null,
  };
}
