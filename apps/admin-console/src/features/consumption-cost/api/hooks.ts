'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';

import { getCostPerEncounter, getTopTenants, getUsageConnections, getUsageSummary } from './client';
import { consumptionKeys } from './keys';
import type { CostPerEncounterResponse, TopTenantsResponse, UsageConnection, UsagePeriodParams, UsageSummaryResponse } from './types';

/**
 * TanStack Query hooks for the Consumption & Cost screen.
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

/**
 * TASK-958 D-7 — connection id → the name a tenant admin gave it.
 *
 * ONE query over the three capabilities a tenant can hold several accounts of
 * (`llm | stt | tts`, the `BYO_DECLARABLE_SERVICES`); connection ids are
 * globally unique, so a flat map needs no service key. Gated by `enabled`: when
 * no usage line carries a `connectionId` there is nothing to resolve, and this
 * screen must not read the provider plane at all.
 *
 * A failed or forbidden read is NOT an error state here — it degrades to an
 * empty map and the table falls back to the id, which still distinguishes two
 * accounts. Naming is a nicety; identity is the requirement.
 */
export function useUsageConnectionNames(enabled: boolean): Map<string, string> {
  const query = useQuery({
    queryKey: consumptionKeys.connections(),
    queryFn: async () => {
      const lists = await Promise.all((['llm', 'stt', 'tts'] as const).map((service) => getUsageConnections(service).catch(() => [] as UsageConnection[])));
      return lists.flat();
    },
    enabled,
    retry: false,
    staleTime: 5 * 60_000,
  });

  return useMemo(() => {
    const names = new Map<string, string>();
    for (const row of query.data ?? []) {
      if (!row.id) continue;
      names.set(row.id, row.name?.trim() || row.slug || row.provider);
    }
    return names;
  }, [query.data]);
}
