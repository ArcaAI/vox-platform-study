import { describe, expect, it } from 'vitest';
import { bucketConsultations, buildRangeBuckets, rangeWindow } from '../chart';
import type { AdminConsultation } from '@arcaai/vox';

const c = (over: Partial<AdminConsultation> & Record<string, unknown>): AdminConsultation =>
    ({ id: Math.random().toString(36).slice(2), ...over }) as AdminConsultation;

const week = { from: new Date('2026-06-21T00:00:00'), to: new Date('2026-06-27T23:59:59'), preset: 'week' as const };
const year = { from: new Date('2026-01-01T00:00:00'), to: new Date('2026-12-31T23:59:59'), preset: 'year' as const };

describe('chart (consultations → per-bucket new/revisit series)', () => {
    describe('buildRangeBuckets', () => {
        it('produces 7 daily buckets for a week range', () => {
            const buckets = buildRangeBuckets(week);
            expect(buckets).toHaveLength(7);
            expect(buckets[0].label).toBe('Jun 21');
            expect(buckets[6].label).toBe('Jun 27');
            expect(buckets.every((b) => b.granularity === 'day')).toBe(true);
        });
        it('produces 12 monthly buckets for a year range', () => {
            const buckets = buildRangeBuckets(year);
            expect(buckets).toHaveLength(12);
            expect(buckets[0].label).toBe('Jan');
            expect(buckets[11].label).toBe('Dec');
            expect(buckets.every((b) => b.granularity === 'month')).toBe(true);
        });
    });

    describe('bucketConsultations', () => {
        it('assigns consultations to their day bucket and splits new vs revisit', () => {
            const rows = bucketConsultations(
                [
                    c({ createdAt: '2026-06-21T08:00:00' }),
                    c({ createdAt: '2026-06-21T20:00:00', parentConsultationId: 'p1' }),
                    c({ createdAt: '2026-06-27T09:00:00' }),
                ],
                week,
            );
            expect(rows).toHaveLength(7);
            expect(rows[0]).toEqual({ label: 'Jun 21', newVisits: 1, revisits: 1 });
            expect(rows[6]).toEqual({ label: 'Jun 27', newVisits: 1, revisits: 0 });
        });

        it('zero-fills buckets with no consultations', () => {
            const rows = bucketConsultations([], week);
            expect(rows).toHaveLength(7);
            expect(rows.every((r) => r.newVisits === 0 && r.revisits === 0)).toBe(true);
        });

        it('ignores out-of-window and unparseable dates', () => {
            const rows = bucketConsultations(
                [c({ createdAt: '2025-01-01T00:00:00' }), c({ createdAt: 'not-a-date' }), c({ createdAt: undefined })],
                week,
            );
            expect(rows.reduce((sum, r) => sum + r.newVisits + r.revisits, 0)).toBe(0);
        });

        it('buckets by month for a year range', () => {
            const rows = bucketConsultations(
                [c({ createdAt: '2026-01-15T00:00:00' }), c({ createdAt: '2026-12-02T00:00:00', parentConsultationId: 'p' })],
                year,
            );
            expect(rows[0]).toEqual({ label: 'Jan', newVisits: 1, revisits: 0 });
            expect(rows[11]).toEqual({ label: 'Dec', newVisits: 0, revisits: 1 });
        });
    });

    describe('rangeWindow', () => {
        it('spans the first bucket start to the last bucket end', () => {
            const buckets = buildRangeBuckets(week);
            const win = rangeWindow(buckets);
            expect(win?.start.getTime()).toBe(buckets[0].start.getTime());
            expect(win?.end.getTime()).toBe(buckets[6].end.getTime());
        });
        it('returns null for an empty bucket list', () => {
            expect(rangeWindow([])).toBeNull();
        });
    });
});
