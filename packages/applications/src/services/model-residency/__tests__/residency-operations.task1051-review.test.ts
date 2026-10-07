import { describe, expect, it } from 'vitest';
import { type ResidencyConclusion, ResidencyRecommendationStore } from '../residency-operations';

/**
 * TASK-1051 review finding 7 — a dismissal hides ONE standing conclusion for as long as that
 * conclusion stands. When the standing row goes stale (the condition stopped holding), the
 * dismissal goes with it, so a later recurrence shows again. Enforce-mode log rows are history
 * (the command was sent): a dismissal never hides one.
 */
const idle: ResidencyConclusion = { action: 'unload', service: 'nlp', modelRef: 'ner', reason: 'idle_ttl_expired' };
const STALE = 60_000;

describe('ResidencyRecommendationStore — dismissal lifetime (review finding 7)', () => {
  it('a dismissal clears once its standing row goes stale; a recurrence is visible again', () => {
    const store = new ResidencyRecommendationStore(STALE, 10);
    const { recommendation } = store.recordShadow(idle, 'r1', 0);
    expect(store.dismiss(recommendation.id, 1_000)).toBe(true);
    store.recordShadow(idle, 'r2', 10_000);
    expect(store.visible(10_000)).toEqual([]);

    // The condition stops holding: no re-confirmation for longer than the stale window.
    expect(store.visible(10_000 + STALE + 1)).toEqual([]);
    // It comes back later: the operator sees it again.
    store.recordShadow(idle, 'r3', 10_000 + STALE + 5_000);
    expect(store.visible(10_000 + STALE + 5_000).map((r) => r.id)).toEqual(['r3']);
  });

  it('a recurrence recorded before anyone read the view (no prune in between) is still visible again', () => {
    const store = new ResidencyRecommendationStore(STALE, 10);
    store.dismiss(store.recordShadow(idle, 'r1', 0).recommendation.id, 0);
    store.recordShadow(idle, 'r2', STALE + 10_000);
    expect(store.visible(STALE + 10_000).map((r) => r.id)).toEqual(['r2']);
  });

  it('never hides an enforce-log row, and an enforce row cannot be dismissed', () => {
    const store = new ResidencyRecommendationStore(STALE, 10);
    store.dismiss(store.recordShadow(idle, 'shadow-1', 0).recommendation.id, 0);
    const sent = store.recordEnforce(idle, 'enforce-1', true, 1_000);
    expect(store.visible(1_000).map((r) => r.id)).toEqual(['enforce-1']);
    expect(store.dismiss(sent.id, 1_000)).toBe(false);
    expect(store.visible(1_000).map((r) => r.id)).toEqual(['enforce-1']);
  });
});
