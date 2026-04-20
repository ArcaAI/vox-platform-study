import { describe, expect, it } from 'vitest';
import { filterContextItems, type ContextItemLike } from '../filter-context-items';

const now = new Date('2026-02-20T12:00:00Z');

const items: ContextItemLike[] = [
  { id: 'ctx-alice-1', type: 'CASE_NOTE', content: 'Chest pain follow-up', consultationId: 'c-alice-1', createdAt: '2026-02-20T10:00:00Z' },
  { id: 'ctx-alice-2', type: 'TRANSCRIPT', content: 'Patient reports migraine', consultationId: 'c-alice-1', createdAt: '2026-02-19T10:00:00Z' },
  { id: 'ctx-bob-1', type: 'CASE_NOTE', content: 'Hb 12.5 WBC 8000', consultationId: 'c-bob-1', createdAt: '2026-02-15T10:00:00Z' },
];

const patientMap = { 'c-alice-1': 'alice', 'c-bob-1': 'bob' };

describe('filterContextItems', () => {
  it('returns everything when filters are permissive', () => {
    const result = filterContextItems(items, { query: '', type: 'ALL', recency: 'ALL' }, now);
    expect(result).toHaveLength(3);
  });

  it('filters by patient via consultationPatientMap', () => {
    const result = filterContextItems(
      items,
      { query: '', type: 'ALL', recency: 'ALL', patientId: 'alice', consultationPatientMap: patientMap },
      now,
    );
    expect(result.map((i) => i.id)).toEqual(['ctx-alice-1', 'ctx-alice-2']);
  });

  it("treats 'ALL' patientId as no filter", () => {
    const result = filterContextItems(
      items,
      { query: '', type: 'ALL', recency: 'ALL', patientId: 'ALL', consultationPatientMap: patientMap },
      now,
    );
    expect(result).toHaveLength(3);
  });

  it('fuzzy-matches content as well as id', () => {
    const result = filterContextItems(items, { query: 'WBC', type: 'ALL', recency: 'ALL' }, now);
    expect(result.map((i) => i.id)).toEqual(['ctx-bob-1']);
  });

  it('combines type + recency + patient filters', () => {
    const result = filterContextItems(
      items,
      {
        query: '',
        type: 'CASE_NOTE',
        recency: '24H',
        patientId: 'alice',
        consultationPatientMap: patientMap,
      },
      now,
    );
    expect(result.map((i) => i.id)).toEqual(['ctx-alice-1']);
  });
});
