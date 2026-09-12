'use client';

import { useMemo } from 'react';
import { useQuery } from '@tanstack/react-query';

import { getCostPerEncounter, getTopTenants, getUsageConnections, getUsagePlatformDefaults, getUsageSummary, getUsageTimeseries } from './client';
import { consumptionKeys } from './keys';
import type {
  CostPerEncounterResponse,
  TopTenantsResponse,
  UsageConnection,
  UsagePeriodParams,
  UsagePlatformDefaults,
  UsageSummaryResponse,
  UsageTimeseriesParams,
  UsageTimeseriesResponse,
} from './types';

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

export interface UsageTimeseriesView {
  isPending: boolean;
  error: Error | null;
  refetch: () => void;
  data: UsageTimeseriesResponse | null;
}

/**
 * TASK-959 — the usage-over-time chart's series. `enabled` is gated on a
 * resolved (capability, unit) default (`pickDefaultSeries`) — there is
 * nothing to chart before the summary itself has loaded at least one line.
 */
export function useUsageTimeseries(enabled: boolean, params?: UsageTimeseriesParams): UsageTimeseriesView {
  const query = useQuery({
    queryKey: consumptionKeys.timeseries(params),
    queryFn: () => getUsageTimeseries(params as UsageTimeseriesParams),
    enabled: enabled && !!params,
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
 * BOTH TIERS OF THE CASCADE, not just the tenant's own (wire review #6). A
 * platform-funded generation carries the SYSTEM row's `connectionId` — `null` is
 * reserved for a self-hosted engine, which spends no vendor account at all — so
 * resolving against the tenant's list alone left every platform-funded line
 * rendering 8 characters of a UUID. That reads as "a connection of yours we
 * could not name" for a row the tenant does not own, cannot name and cannot
 * open. A SYSTEM row is therefore labelled by what it IS: `Platform · <provider>`.
 *
 * The label comes from the row itself rather than from a vendor-label table:
 * `features/ai-providers` owns that table, features never import one another,
 * and a second copy here would drift silently. The provider id is what the
 * cascade calls the row, and it is the half of the answer that matters — WHOSE
 * account paid.
 *
 * A failed or forbidden read is NOT an error state here — it degrades to an
 * empty map and the table falls back to the id, which still distinguishes two
 * accounts. Naming is a nicety; identity is the requirement.
 */
export function useUsageConnectionNames(enabled: boolean): Map<string, string> {
  const query = useQuery({
    queryKey: consumptionKeys.connections(),
    queryFn: async () => {
      const services = ['llm', 'stt', 'tts'] as const;
      const [tenant, platform] = await Promise.all([
        Promise.all(services.map((service) => getUsageConnections(service).catch(() => [] as UsageConnection[]))),
        Promise.all(services.map((service) => getUsagePlatformDefaults(service).catch(() => ({}) as UsagePlatformDefaults))),
      ]);
      return { tenant: tenant.flat(), platform: platform.flatMap((defaults) => defaults.connections ?? []) };
    },
    enabled,
    retry: false,
    staleTime: 5 * 60_000,
  });

  return useMemo(() => {
    const names = new Map<string, string>();
    // Platform first, so a tenant row would win a (impossible) collision: the
    // tenant's own name for its own account is always the better answer.
    for (const row of query.data?.platform ?? []) {
      // No id = a `version: 0` placeholder: the platform holds no row for that
      // provider, so it funded nothing and names nothing.
      if (row.id) names.set(row.id, `Platform · ${row.provider}`);
    }
    for (const row of query.data?.tenant ?? []) {
      if (row.id) names.set(row.id, row.name?.trim() || row.slug || row.provider);
    }
    return names;
  }, [query.data]);
}
