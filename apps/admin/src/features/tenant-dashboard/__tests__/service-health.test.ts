import { describe, expect, it } from 'vitest';
import { AUDIO_PIPELINE_SPECS, audioPipelineRows, normalizeServiceHealth, serviceDisplayName, summarizeServiceHealth } from '../service-health';

describe('service-health (useHealthCheck → dashboard view models)', () => {
    describe('normalizeServiceHealth', () => {
        it('maps healthy synonyms → healthy', () => {
            for (const raw of ['healthy', 'HEALTHY', 'ok', 'up', 'pass', 'ready']) {
                expect(normalizeServiceHealth(raw)).toBe('healthy');
            }
        });
        it('maps degraded synonyms → degraded', () => {
            expect(normalizeServiceHealth('degraded')).toBe('degraded');
            expect(normalizeServiceHealth('warning')).toBe('degraded');
        });
        it('maps down/error/unhealthy → unhealthy', () => {
            expect(normalizeServiceHealth('down')).toBe('unhealthy');
            expect(normalizeServiceHealth('error')).toBe('unhealthy');
            expect(normalizeServiceHealth('unhealthy')).toBe('unhealthy');
        });
        it('maps checking/idle → checking', () => {
            expect(normalizeServiceHealth('checking')).toBe('checking');
            expect(normalizeServiceHealth('idle')).toBe('checking');
        });
        it('falls back to unknown for anything else (incl. null/undefined)', () => {
            expect(normalizeServiceHealth('weird')).toBe('unknown');
            expect(normalizeServiceHealth(null)).toBe('unknown');
            expect(normalizeServiceHealth(undefined)).toBe('unknown');
        });
    });

    describe('serviceDisplayName', () => {
        it('uppercases known acronyms and title-cases the rest', () => {
            expect(serviceDisplayName('smr')).toBe('SMR');
            expect(serviceDisplayName('stt')).toBe('STT');
            expect(serviceDisplayName('nlp')).toBe('NLP');
            expect(serviceDisplayName('api')).toBe('API');
            expect(serviceDisplayName('guardrail')).toBe('Guardrail');
            expect(serviceDisplayName('harness')).toBe('Harness');
        });
    });

    describe('summarizeServiceHealth', () => {
        it('counts healthy/total and lists degraded display names', () => {
            const summary = summarizeServiceHealth({
                api: { status: 'healthy' },
                stt: { status: 'healthy' },
                smr: { status: 'degraded' },
                nlp: { status: 'healthy' },
                guardrail: { status: 'healthy' },
                harness: { status: 'healthy' },
                apiLive: { status: 'healthy' },
            });
            expect(summary.total).toBe(7);
            expect(summary.healthy).toBe(6);
            expect(summary.degraded).toEqual(['SMR']);
            expect(summary.allHealthy).toBe(false);
        });

        it('reports all-healthy and an empty degraded list when nothing is degraded', () => {
            const summary = summarizeServiceHealth({ api: { status: 'up' }, stt: { status: 'healthy' } });
            expect(summary).toMatchObject({ healthy: 2, total: 2, degraded: [], allHealthy: true, hasUnhealthy: false });
        });

        it('flags unhealthy services', () => {
            const summary = summarizeServiceHealth({ api: { status: 'down' }, stt: { status: 'healthy' } });
            expect(summary.healthy).toBe(1);
            expect(summary.hasUnhealthy).toBe(true);
        });

        it('handles an empty/missing map without throwing', () => {
            expect(summarizeServiceHealth({})).toMatchObject({ healthy: 0, total: 0, degraded: [] });
            expect(summarizeServiceHealth(null)).toMatchObject({ healthy: 0, total: 0 });
            expect(summarizeServiceHealth(undefined)).toMatchObject({ healthy: 0, total: 0 });
        });
    });

    describe('audioPipelineRows', () => {
        it('returns the fixed STT/VAD/SMR/Guardrail/NLP rows in order with model names', () => {
            const rows = audioPipelineRows({
                stt: { status: 'healthy' },
                smr: { status: 'degraded' },
                guardrail: { status: 'healthy' },
                nlp: { status: 'healthy' },
            });
            expect(rows.map((r) => r.name)).toEqual(['STT', 'VAD', 'SMR', 'Guardrail', 'NLP']);
            expect(rows.find((r) => r.name === 'SMR')?.status).toBe('degraded');
            expect(rows.find((r) => r.name === 'STT')?.version).toBe('whisper-large-v3-turbo');
        });

        it('derives VAD status from STT (no dedicated vad health key — TARGET)', () => {
            const rows = audioPipelineRows({ stt: { status: 'healthy' } });
            const vad = rows.find((r) => r.name === 'VAD');
            expect(vad?.status).toBe('healthy');
            expect(vad?.derived).toBe(true);
        });

        it('marks services with no health datum as unknown', () => {
            const rows = audioPipelineRows({});
            expect(rows.every((r) => r.status === 'unknown')).toBe(true);
        });

        it('exposes the canonical spec list', () => {
            expect(AUDIO_PIPELINE_SPECS.map((s) => s.name)).toEqual(['STT', 'VAD', 'SMR', 'Guardrail', 'NLP']);
        });
    });
});
