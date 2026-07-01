import { describe, expect, it } from 'vitest';
import { formatScore, normalizeMetrics, resolveTestVariables, scorePercent, scoreToneRole } from '../playground-format';

describe('playground-format — score / tone / metrics / variable resolution', () => {
    describe('formatScore', () => {
        it('rounds to 2 decimals and renders an em-dash for null/undefined', () => {
            expect(formatScore(0.923)).toBe('0.92');
            expect(formatScore(null)).toBe('\u2014');
            expect(formatScore(undefined)).toBe('\u2014');
        });
    });

    describe('scorePercent', () => {
        it('converts a [0,1] score to an integer percent (0 when missing)', () => {
            expect(scorePercent(0.9)).toBe(90);
            expect(scorePercent(null)).toBe(0);
        });
    });

    describe('scoreToneRole', () => {
        it('maps the score onto semantic tokens by threshold', () => {
            expect(scoreToneRole(0.92)).toBe('success');
            expect(scoreToneRole(0.7)).toBe('warning');
            expect(scoreToneRole(0.4)).toBe('destructive');
            expect(scoreToneRole(null)).toBe('neutral');
        });
    });

    describe('normalizeMetrics', () => {
        it('humanizes keys, computes percent + tone, preserves order', () => {
            expect(normalizeMetrics({ faithfulness: 0.95, coverage: 0.9, conciseness: 0.55 })).toEqual([
                { key: 'faithfulness', label: 'Faithfulness', value: 0.95, percent: 95, role: 'success' },
                { key: 'coverage', label: 'Coverage', value: 0.9, percent: 90, role: 'success' },
                { key: 'conciseness', label: 'Conciseness', value: 0.55, percent: 55, role: 'destructive' },
            ]);
        });

        it('returns [] when no metrics are present (TARGET sub-metrics absent)', () => {
            expect(normalizeMetrics(undefined)).toEqual([]);
            expect(normalizeMetrics(null)).toEqual([]);
        });
    });

    describe('resolveTestVariables', () => {
        it('keeps only declared names with non-empty values', () => {
            expect(resolveTestVariables(['patient_age', 'chief_complaint'], { patient_age: '58', chief_complaint: '  ', extra: 'x' })).toEqual({
                patient_age: '58',
            });
        });
    });
});
