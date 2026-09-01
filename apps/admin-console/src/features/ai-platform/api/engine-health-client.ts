'use client';

/**
 * Engine health, READ ONLY — a minimal copy of the discovery read, per the
 * same rule-13 posture as `model-store-client.ts`.
 *
 * `features/inference-engines` owns the per-engine screens and keeps its own,
 * fuller types; `features/mlflow` owns the registry screen. This module exists
 * so the unified screen can answer "are my engines up?" in one place without
 * depending on either feature. It never writes.
 *
 * The engine ROUTES are deliberately NOT retired by TASK-845:
 * `inference-engines/components/engine-meta.ts` records why an engine's status
 * needs its own URL, and that reasoning is unaffected by consolidation. This
 * tab is the inventory-level view; the routes stay the depth.
 */

import { useQueries } from '@tanstack/react-query';
import { getJson } from '@/shared/api';

export interface EngineProbe {
  provider: string;
  probeStatus: 'ok' | 'timeout' | 'error' | 'skipped';
  latencyMs?: number;
  error?: string;
  connectionSource?: 'tenant' | 'system';
}

export interface EngineDiscovery {
  entries: { provider: string; modelName: string; status: string; loadState: string }[];
  probes: EngineProbe[];
  probedAt: string;
}

export function useEngineHealth(providers: readonly string[], enabled: boolean) {
  return useQueries({
    queries: providers.map((provider) => ({
      queryKey: ['ai-platform', 'engine-health', provider],
      queryFn: () => getJson<EngineDiscovery>('admin/ai-models/discovery', { provider }),
      enabled,
      staleTime: 30_000,
      // An engine that is not deployed is the EXPECTED answer today, not a
      // transient fault: retrying only makes the screen take three times as
      // long to tell the operator the truth.
      retry: false,
    })),
  });
}
