import { describe, expect, it } from 'vitest';
import {
  CooldownTracker,
  type EngineDevice,
  type EngineModel,
  type EngineSettings,
  PromotionTracker,
  evictionScore,
  planMakeRoom,
  planTick,
} from '../residency-policy-engine';

/**
 * TASK-1005 §5.3 / §8.3 — the deciding algorithm, as pure functions.
 *
 * Every test here is about WHICH action the controller would take; none of them
 * sends anything. Shadow vs enforce, the GPU load gate and the agents are the
 * service's business (`model-residency.service.task1005.test.ts`).
 */

const GiB = 1024 ** 3;

const SETTINGS: EngineSettings = {
  headroomPercent: 15,
  minResidencySeconds: 300,
  reloadCooldownSeconds: 120,
  promotionRateThreshold: 2,
  promotionWindows: 3,
};

/** A 16 GiB card with `freeGiB` free. Headroom 15 % ⇒ 2.4 GiB is never handed out. */
function gpu(id: string, freeGiB: number): EngineDevice {
  return { id, kind: 'gpu', totalBytes: 16 * GiB, freeBytes: freeGiB * GiB };
}

function model(overrides: Partial<EngineModel> & Pick<EngineModel, 'modelRef'>): EngineModel {
  return {
    service: 'nlp',
    resident: true,
    devices: ['gpu0'],
    bytes: 1 * GiB,
    inFlight: 0,
    pinned: false,
    agentPinned: false,
    desiredClass: 'ON_DEMAND',
    classSource: 'default',
    priority: 0,
    idleTtlSeconds: null,
    idleSeconds: 600,
    residentSeconds: 3_600,
    reloadSeconds: 5,
    loadable: true,
    requestsPerMin: 0,
    ...overrides,
  };
}

describe('evictionScore — idleSeconds × 1/reloadSeconds × 1/priorityWeight', () => {
  it('rises with idleness, falls with reload cost and with priority', () => {
    const base = evictionScore(model({ modelRef: 'a', idleSeconds: 600, reloadSeconds: 5, priority: 0 }));
    expect(evictionScore(model({ modelRef: 'a', idleSeconds: 1_200, reloadSeconds: 5, priority: 0 }))).toBeGreaterThan(base);
    expect(evictionScore(model({ modelRef: 'a', idleSeconds: 600, reloadSeconds: 100, priority: 0 }))).toBeLessThan(base);
    expect(evictionScore(model({ modelRef: 'a', idleSeconds: 600, reloadSeconds: 5, priority: 50 }))).toBeLessThan(base);
  });
});

describe('planMakeRoom — cost-aware eviction', () => {
  it('evicts the highest-score (idle, cheap to reload, low priority) candidates first, and only as many as needed', () => {
    const devices = [gpu('gpu0', 4)]; // usable = 4 - 2.4 = 1.6 GiB
    const residents = [
      // cheap to reload, long idle → score 3600/2 = 1800
      model({ modelRef: 'cheap-idle', bytes: 2 * GiB, idleSeconds: 3_600, reloadSeconds: 2 }),
      // expensive to reload (an LLM, ~100 s) → score 3600/100 = 36
      model({ modelRef: 'expensive', bytes: 3 * GiB, idleSeconds: 3_600, reloadSeconds: 100 }),
      // moderately idle → score 1200/2 = 600
      model({ modelRef: 'mid', bytes: 1 * GiB, idleSeconds: 1_200, reloadSeconds: 2 }),
    ];

    // Need 4 GiB: 1.6 usable + cheap-idle (2) = 3.6 < 4, + mid (1) = 4.6 ≥ 4.
    const plan = planMakeRoom(4 * GiB, ['gpu0'], devices, residents, SETTINGS);

    expect(plan.fits).toBe(true);
    expect(plan.evict.map((m) => m.modelRef)).toEqual(['cheap-idle', 'mid']);
  });

  it('evicts nothing when the model already fits within the headroom-adjusted free memory', () => {
    const plan = planMakeRoom(1 * GiB, ['gpu0'], [gpu('gpu0', 10)], [model({ modelRef: 'x' })], SETTINGS);
    expect(plan).toEqual({ fits: true, evict: [] });
  });

  it('never evicts a pinned model, one with in-flight work, or one resident for less than minResidencySeconds', () => {
    const residents = [
      model({ modelRef: 'pinned', bytes: 8 * GiB, idleSeconds: 99_999, pinned: true }),
      model({ modelRef: 'busy', bytes: 8 * GiB, idleSeconds: 99_999, inFlight: 1 }),
      model({ modelRef: 'young', bytes: 8 * GiB, idleSeconds: 99_999, residentSeconds: 60 }),
    ];

    const plan = planMakeRoom(6 * GiB, ['gpu0'], [gpu('gpu0', 2)], residents, SETTINGS);

    expect(plan.fits).toBe(false);
    expect(plan.evict).toEqual([]);
  });

  it('refuses admission — evicting nothing at all — when even every evictable candidate would not make it fit', () => {
    const residents = [model({ modelRef: 'small-a', bytes: 1 * GiB }), model({ modelRef: 'small-b', bytes: 1 * GiB })];
    const plan = planMakeRoom(10 * GiB, ['gpu0'], [gpu('gpu0', 3)], residents, SETTINGS);
    expect(plan).toEqual({ fits: false, evict: [] });
  });

  it('pools every device a multi-card model spans (LM Studio splits across both cards)', () => {
    // 5 GiB free on each card: usable 2.6 + 2.6 = 5.2 GiB.
    const plan = planMakeRoom(5 * GiB, ['gpu0', 'gpu1'], [gpu('gpu0', 5), gpu('gpu1', 5)], [], SETTINGS);
    expect(plan.fits).toBe(true);
  });
});

describe('PromotionTracker — hysteresis', () => {
  it('does not promote before N consecutive windows at or above the threshold', () => {
    const tracker = new PromotionTracker();
    const key = 'nlp|blaze999/Medical-NER';

    // alpha 1 so the EWMA equals the observation — isolates the window count.
    tracker.observe(key, 10, SETTINGS, 1);
    expect(tracker.isPromoted(key)).toBe(false);
    tracker.observe(key, 10, SETTINGS, 1);
    expect(tracker.isPromoted(key)).toBe(false);
    tracker.observe(key, 10, SETTINGS, 1);
    expect(tracker.isPromoted(key)).toBe(true);
  });

  it('a single window below the threshold restarts the count', () => {
    const tracker = new PromotionTracker();
    const key = 'nlp|x';
    tracker.observe(key, 10, SETTINGS, 1);
    tracker.observe(key, 10, SETTINGS, 1);
    tracker.observe(key, 0, SETTINGS, 1);
    tracker.observe(key, 10, SETTINGS, 1);
    tracker.observe(key, 10, SETTINGS, 1);
    expect(tracker.isPromoted(key)).toBe(false);
    tracker.observe(key, 10, SETTINGS, 1);
    expect(tracker.isPromoted(key)).toBe(true);
  });

  it('demotes only once the EWMA falls below HALF the threshold (a band, not a line)', () => {
    const tracker = new PromotionTracker();
    const key = 'nlp|x';
    for (let i = 0; i < 3; i += 1) tracker.observe(key, 10, SETTINGS, 1);
    tracker.observe(key, 1.5, SETTINGS, 1); // below threshold 2, above 1
    expect(tracker.isPromoted(key)).toBe(true);
    tracker.observe(key, 0.5, SETTINGS, 1);
    expect(tracker.isPromoted(key)).toBe(false);
  });
});

describe('CooldownTracker', () => {
  it('blocks a reload within reloadCooldownSeconds of the unload, and not after', () => {
    const cooldown = new CooldownTracker();
    cooldown.noteUnloaded('stt|whisper', 1_000_000);
    expect(cooldown.blocks('stt|whisper', 1_000_000 + 60_000, 120)).toBe(true);
    expect(cooldown.blocks('stt|whisper', 1_000_000 + 121_000, 120)).toBe(false);
    expect(cooldown.blocks('stt|other', 1_000_000, 120)).toBe(false);
  });
});

describe('planTick — one pass of §5.3', () => {
  const noCooldown = () => false;

  it('loads a non-resident implicit live-path model (reason live_path_pin)', () => {
    const decisions = planTick({
      models: [
        model({ modelRef: 'whisper', service: 'stt', resident: false, desiredClass: 'PINNED', classSource: 'implicit-live-path', pinned: true }),
      ],
      devices: [gpu('gpu0', 12)],
      settings: SETTINGS,
      promoted: new Set(),
      coolingDown: noCooldown,
    });
    expect(decisions).toEqual([expect.objectContaining({ action: 'load', service: 'stt', modelRef: 'whisper', reason: 'live_path_pin' })]);
  });

  it('the cool-down blocks a reload of a model unloaded moments ago', () => {
    const decisions = planTick({
      models: [model({ modelRef: 'whisper', service: 'stt', resident: false, desiredClass: 'PINNED', pinned: true })],
      devices: [gpu('gpu0', 12)],
      settings: SETTINGS,
      promoted: new Set(),
      coolingDown: (key) => key === 'stt|whisper',
    });
    expect(decisions.filter((d) => d.action === 'load')).toEqual([]);
  });

  it('makes room by evicting (reason make_room) BEFORE the load, and never touches a pinned resident', () => {
    const decisions = planTick({
      models: [
        model({ modelRef: 'big-pinned', bytes: 6 * GiB, pinned: true, agentPinned: true, desiredClass: 'PINNED', idleSeconds: 99_999 }),
        model({ modelRef: 'idle-small', bytes: 3 * GiB, idleSeconds: 3_600 }),
        model({ modelRef: 'wanted', resident: false, bytes: 4 * GiB, desiredClass: 'PINNED', pinned: true, classSource: 'policy' }),
      ],
      devices: [gpu('gpu0', 3.5)], // usable 1.1 GiB
      settings: SETTINGS,
      promoted: new Set(),
      coolingDown: noCooldown,
    });

    expect(decisions.map((d) => [d.action, d.modelRef, d.reason])).toEqual([
      ['unload', 'idle-small', 'make_room'],
      ['load', 'wanted', 'live_path_pin'],
    ]);
  });

  it('records admission_rejected — and evicts nothing — when no evictable candidate can make room', () => {
    const decisions = planTick({
      models: [
        model({ modelRef: 'busy', bytes: 8 * GiB, inFlight: 2 }),
        model({ modelRef: 'wanted', resident: false, bytes: 6 * GiB, desiredClass: 'PINNED', pinned: true }),
      ],
      devices: [gpu('gpu0', 3)],
      settings: SETTINGS,
      promoted: new Set(),
      coolingDown: noCooldown,
    });
    expect(decisions).toEqual([expect.objectContaining({ action: 'load', modelRef: 'wanted', reason: 'admission_rejected' })]);
  });

  it('loads a WARM model only once promoted (reason promotion_rate)', () => {
    const warm = model({ modelRef: 'warm', resident: false, desiredClass: 'WARM', classSource: 'policy' });
    const base = { models: [warm], devices: [gpu('gpu0', 12)], settings: SETTINGS, coolingDown: noCooldown };

    expect(planTick({ ...base, promoted: new Set() })).toEqual([]);
    expect(planTick({ ...base, promoted: new Set(['nlp|warm']) })).toEqual([
      expect.objectContaining({ action: 'load', modelRef: 'warm', reason: 'promotion_rate' }),
    ]);
  });

  it('expires an idle ON_DEMAND model past its TTL (reason idle_ttl_expired) — never a pinned, busy or young one', () => {
    const decisions = planTick({
      models: [
        model({ modelRef: 'expired', idleTtlSeconds: 300, idleSeconds: 900 }),
        model({ modelRef: 'not-yet', idleTtlSeconds: 1_800, idleSeconds: 900 }),
        model({ modelRef: 'pinned', idleTtlSeconds: 300, idleSeconds: 900, pinned: true }),
        model({ modelRef: 'busy', idleTtlSeconds: 300, idleSeconds: 900, inFlight: 1 }),
        model({ modelRef: 'young', idleTtlSeconds: 60, idleSeconds: 120, residentSeconds: 120 }),
        model({ modelRef: 'no-ttl', idleTtlSeconds: null, idleSeconds: 99_999 }),
      ],
      devices: [gpu('gpu0', 12)],
      settings: SETTINGS,
      promoted: new Set(),
      coolingDown: noCooldown,
    });
    expect(decisions.map((d) => [d.action, d.modelRef, d.reason])).toEqual([['unload', 'expired', 'idle_ttl_expired']]);
  });

  it('keeps a promoted WARM model resident past its TTL', () => {
    const decisions = planTick({
      models: [model({ modelRef: 'warm', desiredClass: 'WARM', idleTtlSeconds: 300, idleSeconds: 900 })],
      devices: [gpu('gpu0', 12)],
      settings: SETTINGS,
      promoted: new Set(['nlp|warm']),
      coolingDown: noCooldown,
    });
    expect(decisions).toEqual([]);
  });

  it('asks the agent to pin a resident live-path model it does not yet hold pinned (reason live_path_pin)', () => {
    const decisions = planTick({
      models: [
        model({ modelRef: 'whisper', service: 'stt', desiredClass: 'PINNED', classSource: 'implicit-live-path', pinned: true, agentPinned: false }),
      ],
      devices: [gpu('gpu0', 12)],
      settings: SETTINGS,
      promoted: new Set(),
      coolingDown: noCooldown,
    });
    expect(decisions).toEqual([expect.objectContaining({ action: 'pin', modelRef: 'whisper', reason: 'live_path_pin' })]);
  });
});
