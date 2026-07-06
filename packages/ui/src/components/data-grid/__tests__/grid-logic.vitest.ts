import { describe, it, expect } from 'vitest';

import { computeResizeDelta } from '../column-resize';
import { booleanFilterRule, relativePresetToRange, RELATIVE_DATE_PRESETS } from '../filter-controls';
import { buildQueryAnnouncement } from '../announce';

describe('computeResizeDelta — keyboard resize (WCAG 2.5.7)', () => {
  it('±16 on Arrow keys', () => {
    expect(computeResizeDelta('ArrowRight', false)).toBe(16);
    expect(computeResizeDelta('ArrowLeft', false)).toBe(-16);
  });
  it('±48 on Shift+Arrow', () => {
    expect(computeResizeDelta('ArrowRight', true)).toBe(48);
    expect(computeResizeDelta('ArrowLeft', true)).toBe(-48);
  });
  it('Home / Enter reset', () => {
    expect(computeResizeDelta('Home', false)).toBe('reset');
    expect(computeResizeDelta('Enter', false)).toBe('reset');
  });
  it('ignores unrelated keys', () => {
    expect(computeResizeDelta('a', false)).toBeNull();
    expect(computeResizeDelta('Tab', false)).toBeNull();
  });
});

describe('booleanFilterRule — 3-state Any/Yes/No', () => {
  it('Any clears the filter (null)', () => {
    expect(booleanFilterRule('any', 'active')).toBeNull();
  });
  it('Yes → eq true', () => {
    expect(booleanFilterRule('yes', 'active')).toEqual({ id: 'active', operator: 'eq', value: 'true', variant: 'boolean' });
  });
  it('No → eq false', () => {
    expect(booleanFilterRule('no', 'active')).toEqual({ id: 'active', operator: 'eq', value: 'false', variant: 'boolean' });
  });
});

describe('relativePresetToRange — Today / Last 7 / 30 / 90', () => {
  const now = new Date('2026-07-06T10:00:00.000Z');

  it('exposes the four presets in order', () => {
    expect(RELATIVE_DATE_PRESETS.map((p) => p.value)).toEqual(['today', 'last7', 'last30', 'last90']);
  });

  it('today → [startOfDay, endOfDay]', () => {
    const [start, end] = relativePresetToRange('today', now);
    expect(start).toBe('2026-07-06');
    expect(end).toBe('2026-07-06');
  });

  it('last7 → [today-7, today]', () => {
    const [start, end] = relativePresetToRange('last7', now);
    expect(start).toBe('2026-06-29');
    expect(end).toBe('2026-07-06');
  });

  it('last30 → [today-30, today]', () => {
    const [start] = relativePresetToRange('last30', now);
    expect(start).toBe('2026-06-06');
  });
});

describe('buildQueryAnnouncement — polite live-region text', () => {
  it('announces sort', () => {
    const msg = buildQueryAnnouncement({
      sorting: [{ id: 'name', desc: false }],
      filters: [],
      globalSearch: '',
      pagination: { mode: 'offset', page: 0, limit: 25 },
      total: 10,
      pageCount: 1,
      labelFor: (id) => (id === 'name' ? 'Name' : id),
    });
    expect(msg).toContain('Sorted by Name, ascending');
  });

  it('announces filters + result count', () => {
    const msg = buildQueryAnnouncement({
      sorting: [],
      filters: [{ id: 'status', operator: 'inArray', value: ['A'], variant: 'multiSelect' }],
      globalSearch: 'x',
      pagination: { mode: 'offset', page: 0, limit: 25 },
      total: 24,
      pageCount: 1,
      labelFor: (id) => id,
    });
    expect(msg).toContain('2 filters');
    expect(msg).toContain('24 results');
  });

  it('announces page position (offset)', () => {
    const msg = buildQueryAnnouncement({
      sorting: [],
      filters: [],
      globalSearch: '',
      pagination: { mode: 'offset', page: 2, limit: 25 },
      total: 480,
      pageCount: 20,
      labelFor: (id) => id,
    });
    expect(msg).toContain('Page 3 of 20');
  });
});
