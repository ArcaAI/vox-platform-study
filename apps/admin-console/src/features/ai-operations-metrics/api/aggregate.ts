/**
 * Pure rollups for the AI Operations — Metrics screen. Kept free of React/query
 * concerns so they are unit-testable in isolation.
 *
 * - `aggregateGenerationStats` remains for unit tests / offline fixtures; the
 *   live Metrics screen reads `GET admin/agent-trajectory/metrics/generation`.
 * - `aggregateGate` still powers the regeneration / SLA panel from the gate queue.
 */

import { normalizeGenerationStats } from './normalize-generation-stats';
import type { GateQueue, TrajectoryStep } from './types';

function percentile(sortedAsc: number[], fraction: number): number | null {
    if (sortedAsc.length === 0) return null;
    if (sortedAsc.length === 1) return sortedAsc[0];
    const rank = fraction * (sortedAsc.length - 1);
    const low = Math.floor(rank);
    const high = Math.ceil(rank);
    if (low === high) return sortedAsc[low];
    return sortedAsc[low] + (sortedAsc[high] - sortedAsc[low]) * (rank - low);
}

function mean(values: number[]): number | null {
    if (values.length === 0) return null;
    return values.reduce((sum, value) => sum + value, 0) / values.length;
}

export interface StopReasonCount {
    reason: string;
    count: number;
}

export interface GenerationAggregate {
    /** LLM steps that carried GenerationStats. */
    sampleCount: number;
    ttftMedianMs: number | null;
    ttftP95Ms: number | null;
    tokensPerSecondAvg: number | null;
    stopReasons: StopReasonCount[];
}

/** Roll GenerationStats across sampled steps into the screen's panels. */
export function aggregateGenerationStats(steps: TrajectoryStep[]): GenerationAggregate {
    const ttft: number[] = [];
    const toks: number[] = [];
    const stopReasons = new Map<string, number>();
    let sampleCount = 0;

    for (const step of steps) {
        const stats = normalizeGenerationStats(step.stats);
        if (!stats) continue;
        sampleCount += 1;
        if (typeof stats.ttftMs === 'number') ttft.push(stats.ttftMs);
        if (typeof stats.tokensPerSecond === 'number') toks.push(stats.tokensPerSecond);
        if (typeof stats.stopReason === 'string' && stats.stopReason) {
            stopReasons.set(stats.stopReason, (stopReasons.get(stats.stopReason) ?? 0) + 1);
        }
    }

    ttft.sort((a, b) => a - b);

    return {
        sampleCount,
        ttftMedianMs: percentile(ttft, 0.5),
        ttftP95Ms: percentile(ttft, 0.95),
        tokensPerSecondAvg: mean(toks),
        stopReasons: [...stopReasons.entries()]
            .map(([reason, count]) => ({ reason, count }))
            .sort((a, b) => b.count - a.count || a.reason.localeCompare(b.reason)),
    };
}

export interface GateAggregate {
    pending: number;
    totalGenerate: number;
    totalRegen: number;
    /** regenerations / generations, as a percentage; null when no generations. */
    regenRatePct: number | null;
    slaBreached: number;
    escalated: number;
}

/** Roll the gate queue into the regeneration / SLA panel. */
export function aggregateGate(queue: GateQueue): GateAggregate {
    const totalGenerate = queue.items.reduce((sum, item) => sum + item.generateCount, 0);
    const totalRegen = queue.items.reduce((sum, item) => sum + item.regenCount, 0);
    return {
        pending: queue.total,
        totalGenerate,
        totalRegen,
        regenRatePct: totalGenerate > 0 ? (totalRegen / totalGenerate) * 100 : null,
        slaBreached: queue.slaBreachedCount,
        escalated: queue.escalatedCount,
    };
}
