import { describe, expect, it } from 'vitest';
import { type EngineModel, type EngineSettings, planTick } from '../residency-policy-engine';

/**
 * TASK-1051 review finding 3 — a desired model with NO size (never measured, no catalogue size) is
 * never placed against 0 bytes: the engine rejects its admission, exactly as an operator's
 * un-forced load is refused NO_SIZE.
 */
const GiB = 1024 ** 3;
const settings: EngineSettings = {
  headroomPercent: 15,
  minResidencySeconds: 300,
  reloadCooldownSeconds: 120,
  promotionRateThreshold: 5,
  promotionWindows: 3,
};

function desired(over: Partial<EngineModel>): EngineModel {
  return {
    service: 'stt',
    modelRef: 'm',
    resident: false,
    devices: ['gpu0'],
    bytes: 1 * GiB,
    inFlight: 0,
    pinned: true,
    agentPinned: false,
    desiredClass: 'PINNED',
    classSource: 'implicit-live-path',
    priority: 0,
    idleTtlSeconds: null,
    idleSeconds: 0,
    residentSeconds: 0,
    reloadSeconds: null,
    loadable: true,
    requestsPerMin: 0,
    ...over,
  };
}

describe('planTick — unknown size (review finding 3)', () => {
  const devices = [{ id: 'gpu0', kind: 'gpu' as const, totalBytes: 16 * GiB, freeBytes: 14 * GiB }];

  it('rejects admission of a model whose size is unknown instead of placing it at 0 bytes', () => {
    const decisions = planTick({
      models: [desired({ modelRef: 'sized', bytes: 1 * GiB }), desired({ modelRef: 'unsized', bytes: null })],
      devices,
      settings,
      promoted: new Set(),
      coolingDown: () => false,
    });
    expect(decisions).toContainEqual(expect.objectContaining({ action: 'load', modelRef: 'sized', reason: 'live_path_pin' }));
    expect(decisions).toContainEqual({
      action: 'load',
      service: 'stt',
      modelRef: 'unsized',
      reason: 'admission_rejected',
      devices: ['gpu0'],
      bytes: null,
    });
    expect(decisions.filter((d) => d.modelRef === 'unsized')).toHaveLength(1);
  });

  it('an unsized model never causes an eviction', () => {
    const victim = desired({
      modelRef: 'idle',
      resident: true,
      pinned: false,
      desiredClass: 'ON_DEMAND',
      classSource: 'default',
      bytes: 10 * GiB,
      idleSeconds: 9_999,
      residentSeconds: 9_999,
    });
    const decisions = planTick({
      models: [victim, desired({ modelRef: 'unsized', bytes: null })],
      devices: [{ id: 'gpu0', kind: 'gpu', totalBytes: 16 * GiB, freeBytes: 1 * GiB }],
      settings,
      promoted: new Set(),
      coolingDown: () => false,
    });
    expect(decisions.filter((d) => d.action === 'unload')).toEqual([]);
  });
});
