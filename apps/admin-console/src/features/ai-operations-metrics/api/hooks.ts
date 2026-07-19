'use client';

import { useQuery } from '@tanstack/react-query';
import { aggregateGate, type GateAggregate, type GenerationAggregate } from './aggregate';
import { getGateQueue, getGenerationMetrics } from './client';
import { aiMetricsKeys } from './keys';
import type { GenerationMetricsParams } from './types';

const EMPTY_GENERATION: GenerationAggregate = {
    sampleCount: 0,
    ttftMedianMs: null,
    ttftP95Ms: null,
    tokensPerSecondAvg: null,
    stopReasons: [],
};

/** Gate-queue rollup for the regeneration / SLA panel (tenant-scoped, enabled by the caller). */
export function useGateMetrics(enabled: boolean): {
    isPending: boolean;
    error: Error | null;
    refetch: () => void;
    aggregate: GateAggregate | null;
} {
    const query = useQuery({ queryKey: aiMetricsKeys.gateQueue(), queryFn: getGateQueue, enabled });
    return {
        isPending: query.isPending,
        error: (query.error as Error | null) ?? null,
        refetch: () => void query.refetch(),
        aggregate: query.data ? aggregateGate(query.data) : null,
    };
}

export interface GenerationMetrics {
    isPending: boolean;
    error: Error | null;
    refetch: () => void;
    aggregate: GenerationAggregate;
}

/**
 * TTFT / tok-s / stop-reason panels from the server-side generation-metrics
 * aggregate (TASK-509). `normalizeGenerationStats` remains for Runs StepStats
 * and the pure client rollup helper used in unit tests.
 */
export function useGenerationMetrics(enabled: boolean, params?: GenerationMetricsParams): GenerationMetrics {
    const query = useQuery({
        queryKey: aiMetricsKeys.generation(params),
        queryFn: () => getGenerationMetrics(params),
        enabled,
    });

    return {
        isPending: query.isPending,
        error: (query.error as Error | null) ?? null,
        refetch: () => void query.refetch(),
        aggregate: query.data ?? EMPTY_GENERATION,
    };
}
