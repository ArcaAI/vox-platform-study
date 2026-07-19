/**
 * Unit tests for client-side GenerationStats rollups. Trajectory emitters store
 * AD-1 stats as snake_case; the Metrics screen historically expected camelCase —
 * both must aggregate identically.
 */

import { describe, expect, it } from 'vitest';
import { aggregateGenerationStats } from '../aggregate';
import type { TrajectoryStep } from '../types';

function step(stats: Record<string, unknown> | null, id = 's1'): TrajectoryStep {
    return {
        id,
        tenantId: 'tnt-1',
        consultationId: 'c-1',
        sessionKind: 'HARNESS_DOC',
        sessionId: 'wf-1',
        runId: 'run-1',
        seq: 1,
        stepType: stats ? 'LLM_CALL' : 'PHASE',
        name: stats ? 'generate' : 'NER',
        status: 'OK',
        startedAt: '2026-07-01T00:00:00.000Z',
        endedAt: '2026-07-01T00:00:01.000Z',
        durationMs: 1000,
        stats,
        errorCode: null,
        correlationId: null,
        createdAt: '2026-07-01T00:00:00.000Z',
    };
}

describe('aggregateGenerationStats', () => {
    it('aggregates camelCase GenerationStats (legacy console shape)', () => {
        const result = aggregateGenerationStats([
            step({ ttftMs: 120, tokensPerSecond: 40, stopReason: 'stop' }, 'a'),
            step({ ttftMs: 200, tokensPerSecond: 60, stopReason: 'length' }, 'b'),
        ]);

        expect(result.sampleCount).toBe(2);
        expect(result.ttftMedianMs).toBe(160);
        expect(result.tokensPerSecondAvg).toBe(50);
        expect(result.stopReasons).toEqual([
            { reason: 'length', count: 1 },
            { reason: 'stop', count: 1 },
        ]);
    });

    it('aggregates snake_case AD-1 GenerationStats from trajectory emitters', () => {
        const result = aggregateGenerationStats([
            step({ ttft_ms: 120, tokens_per_second: 40, stop_reason: 'stop' }, 'a'),
            step({ ttft_ms: 200, tokens_per_second: 60, stop_reason: 'length' }, 'b'),
        ]);

        expect(result.sampleCount).toBe(2);
        expect(result.ttftMedianMs).toBe(160);
        expect(result.tokensPerSecondAvg).toBe(50);
        expect(result.stopReasons).toEqual([
            { reason: 'length', count: 1 },
            { reason: 'stop', count: 1 },
        ]);
    });

    it('mixes snake_case and camelCase steps in one sample', () => {
        const result = aggregateGenerationStats([
            step({ ttft_ms: 100, tokens_per_second: 20, stop_reason: 'stop' }, 'a'),
            step({ ttftMs: 300, tokensPerSecond: 40, stopReason: 'stop' }, 'b'),
        ]);

        expect(result.sampleCount).toBe(2);
        expect(result.ttftMedianMs).toBe(200);
        expect(result.tokensPerSecondAvg).toBe(30);
        expect(result.stopReasons).toEqual([{ reason: 'stop', count: 2 }]);
    });
});
