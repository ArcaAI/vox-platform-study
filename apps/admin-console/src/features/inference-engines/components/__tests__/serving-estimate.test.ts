/**
 * TASK-996 Phase 5 — the load precheck arithmetic.
 *
 * The one thing these tests protect is HONESTY. `kvCacheEstimateBytes` is
 * derived by the gateway from `context x parallel`, never measured, so a
 * console that projects a NEW profile from it is compounding an estimate. That
 * is acceptable — an admin needs to see an over-budget load before pressing the
 * button, not only as a 409 afterwards — but only while the number is labelled
 * as what it is and the assumptions behind it are stated rather than hidden.
 *
 * Three of those assumptions are encoded here and must not drift silently:
 *   1. KV residency scales with `contextLength x parallel` (measured on the live
 *      pod, ticket §2.1: LM Studio gives EVERY parallel slot the full context).
 *   2. "Apply & reload" unloads first, so the instance's own current footprint
 *      returns to the pool and counts as headroom.
 *   3. A model with no loaded instance yields NO estimate — there are no
 *      measured weights to project from, and inventing one would be worse than
 *      saying so.
 */

import { describe, expect, it } from 'vitest';
import type { LmStudioDevice, LmStudioLoadedModel } from '../../api/serving-types';
import { BYTES_PER_MIB, projectServingFootprint } from '../serving-estimate';

const DEVICES: LmStudioDevice[] = [
  { index: 0, name: 'NVIDIA RTX 2000 Ada', totalMib: 16_380, usedMib: 2_668, freeMib: 13_712 },
  { index: 1, name: 'NVIDIA RTX 2000 Ada', totalMib: 16_380, usedMib: 4_814, freeMib: 11_566 },
];

/** 65536 x 4, 3.35 GB of weights — the profile measured on the live pod. */
const LOADED: LmStudioLoadedModel = {
  identifier: 'gemma-4-e2b-it-qat',
  modelKey: 'gemma-4-e2b-it-qat',
  weightsBytes: 3_350_000_000,
  status: 'IDLE',
  effective: { contextLength: 65_536, parallel: 4, flashAttention: true },
  kvCacheEstimateBytes: 2_000_000_000,
};

describe('projectServingFootprint — the KV projection', () => {
  it('scales the KV estimate with context x parallel', () => {
    const halved = projectServingFootprint({
      loaded: LOADED,
      draft: { contextLength: 32_768, parallel: 4 },
      devices: DEVICES,
    });

    // 32768 x 4 is half of 65536 x 4, so the KV half halves; weights do not move.
    expect(halved.estimateBytes).toBe(3_350_000_000 + 1_000_000_000);
    expect(halved.scaled).toBe(true);
  });

  it('leaves the estimate at the current residency when neither factor changes', () => {
    const unchanged = projectServingFootprint({ loaded: LOADED, draft: {}, devices: DEVICES });

    expect(unchanged.estimateBytes).toBe(3_350_000_000 + 2_000_000_000);
    expect(unchanged.scaled).toBe(false);
  });

  it('gives NO estimate for a model that has never been loaded, and says why', () => {
    const none = projectServingFootprint({ loaded: undefined, draft: { contextLength: 65_536 }, devices: DEVICES });

    expect(none.estimateBytes).toBeNull();
    expect(none.unavailableReason).toMatch(/never been loaded|no measured weights/i);
    expect(none.overBudget).toBe(false);
  });
});

describe('projectServingFootprint — the budget it is measured against', () => {
  it('counts only the devices the profile is allowed to use', () => {
    const pinned = projectServingFootprint({
      loaded: LOADED,
      draft: { gpuSplit: { strategy: 'priorityOrder', priority: [0], disabledGpus: [1] } },
      devices: DEVICES,
    });

    expect(pinned.eligibleDeviceIndexes).toEqual([0]);
    expect(pinned.freeBytes).toBe(13_712 * BYTES_PER_MIB);
  });

  it('adds back the footprint the reload releases — the instance is unloaded first', () => {
    const projection = projectServingFootprint({ loaded: LOADED, draft: {}, devices: DEVICES });

    expect(projection.reclaimBytes).toBe(3_350_000_000 + 2_000_000_000);
    expect(projection.headroomBytes).toBe(projection.freeBytes + projection.reclaimBytes);
  });

  it('flags a profile whose projection exceeds the headroom', () => {
    // 65536 x 64 is 16x the measured residency: 32 GB of KV against ~25 GiB free.
    const over = projectServingFootprint({ loaded: LOADED, draft: { parallel: 64 }, devices: DEVICES });

    expect(over.overBudget).toBe(true);
    expect(over.estimateBytes).toBeGreaterThan(over.headroomBytes);
  });

  it('does not flag a profile that fits', () => {
    const fits = projectServingFootprint({ loaded: LOADED, draft: { contextLength: 8_192, parallel: 2 }, devices: DEVICES });

    expect(fits.overBudget).toBe(false);
  });
});
