import { describe, expect, it } from 'vitest';
import { countPendingReview, filterToday, isRevisitConsultation, splitVisits } from '../consultations';
import type { AdminConsultation } from '@arcaai/vox';

const c = (over: Partial<AdminConsultation> & Record<string, unknown> = {}): AdminConsultation =>
  ({ id: Math.random().toString(36).slice(2), ...over }) as AdminConsultation;

describe('consultations (new-vs-revisit + pending review)', () => {
  describe('isRevisitConsultation', () => {
    it('is true when a top-level parentConsultationId is present', () => {
      expect(isRevisitConsultation(c({ parentConsultationId: 'parent-1' }))).toBe(true);
    });
    it('is true when parentConsultationId is nested under metadata', () => {
      expect(isRevisitConsultation(c({ metadata: { parentConsultationId: 'parent-1' } }))).toBe(true);
    });
    it('is false when there is no parent (new visit)', () => {
      expect(isRevisitConsultation(c())).toBe(false);
      expect(isRevisitConsultation(c({ parentConsultationId: null }))).toBe(false);
      expect(isRevisitConsultation(c({ parentConsultationId: '' }))).toBe(false);
      expect(isRevisitConsultation(c({ metadata: {} }))).toBe(false);
    });
  });

  describe('splitVisits', () => {
    it('returns total/new/revisit counts', () => {
      const list = [c(), c({ parentConsultationId: 'p1' }), c({ parentConsultationId: 'p2' }), c()];
      expect(splitVisits(list)).toEqual({ total: 4, newVisits: 2, revisits: 2 });
    });
    it('handles an empty list', () => {
      expect(splitVisits([])).toEqual({ total: 0, newVisits: 0, revisits: 0 });
    });
  });

  describe('countPendingReview', () => {
    it('counts PENDING_REVIEW and DRAFT_PENDING_SENSORS (case-insensitive)', () => {
      const list = [c({ status: 'PENDING_REVIEW' }), c({ status: 'draft_pending_sensors' }), c({ status: 'SIGNED' }), c({ status: 'COMPLETED' })];
      expect(countPendingReview(list)).toBe(2);
    });
    it('returns 0 when none are pending', () => {
      expect(countPendingReview([c({ status: 'SIGNED' })])).toBe(0);
      expect(countPendingReview([])).toBe(0);
    });
  });

  describe('filterToday', () => {
    const ref = new Date('2026-06-30T12:00:00.000Z');
    it('keeps only consultations created on the reference calendar day', () => {
      const list = [
        c({ createdAt: '2026-06-30T01:00:00.000Z' }),
        c({ createdAt: '2026-06-30T23:30:00.000Z' }),
        c({ createdAt: '2026-06-29T23:00:00.000Z' }),
        c({ createdAt: undefined }),
      ];
      const today = filterToday(list, ref);
      expect(today).toHaveLength(2);
    });
    it('returns an empty array when nothing matches', () => {
      expect(filterToday([c({ createdAt: '2020-01-01T00:00:00.000Z' })], ref)).toEqual([]);
    });
  });
});
