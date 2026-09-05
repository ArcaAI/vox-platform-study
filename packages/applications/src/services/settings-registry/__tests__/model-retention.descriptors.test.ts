// Retention descriptor contract tests.
//
// The key grammar `<svc>.modelCache.<knob>` covers the in-process services
// under one family rather than introducing a second, parallel
// `models.retention.*` namespace.
//
// TASK-872 narrowed the family to the knobs a client actually parses: the five
// `vramBudgetMb` keys and `tts.modelCache.maxModels` were served to nobody, and
// guardrail's three fed a `retention()` accessor with zero callers, so
// guardrail left `MODEL_CACHE_SERVICES` entirely. The grammar is unchanged —
// what is gone is the part of it that reached no reader.

import { describe, expect, it } from 'vitest';
import { HOPE_SETTINGS_REGISTRY } from '../registry';
import { MODEL_CACHE_SERVICES, MODEL_WEIGHT_SERVICES, SERVICE_RUNTIME_DEFAULTS } from '../descriptors/service-runtime.descriptors';

const DESCRIPTORS = HOPE_SETTINGS_REGISTRY.list();
const registryByKey = new Map(DESCRIPTORS.map((d) => [d.key, d]));

describe('model-cache retention descriptors', () => {
  it('registers an idle TTL for every service with an in-process cache', () => {
    for (const service of MODEL_CACHE_SERVICES) {
      expect(registryByKey.has(`${service}.modelCache.ttlSeconds`), service).toBe(true);
    }
  });

  it('registers maxModels only where the consuming client parses it', () => {
    // tts's own `EffectiveConfigSnapshot.retention()` documents that
    // "maxModels is meaningless here" — its providers bound one pipeline each —
    // so declaring the key would offer a control that reaches nothing.
    for (const service of ['stt', 'nlp', 'harness'] as const) {
      expect(registryByKey.has(`${service}.modelCache.maxModels`), service).toBe(true);
    }
    expect(registryByKey.has('tts.modelCache.maxModels')).toBe(false);
  });

  it('registers NO vramBudgetMb key — no client ever parsed one', () => {
    for (const service of MODEL_CACHE_SERVICES) {
      expect(registryByKey.has(`${service}.modelCache.vramBudgetMb`), service).toBe(false);
    }
    expect(registryByKey.has('guardrail.modelCache.vramBudgetMb')).toBe(false);
  });

  it('serves guardrail no retention group at all — its three cache keys had no reader', () => {
    for (const knob of ['ttlSeconds', 'maxModels', 'vramBudgetMb'] as const) {
      expect(registryByKey.has(`guardrail.modelCache.${knob}`), knob).toBe(false);
    }
    expect(MODEL_CACHE_SERVICES as readonly string[]).not.toContain('guardrail');
  });

  it('still serves guardrail its model WEIGHTS — the two lists are different questions', () => {
    // The regression this guards: collapsing `MODEL_WEIGHT_SERVICES` back into
    // `MODEL_CACHE_SERVICES` would stop `resolveModelWeights` telling guardrail
    // where its weights live, which is a behaviour change hiding in a cleanup.
    expect(MODEL_WEIGHT_SERVICES as readonly string[]).toContain('guardrail');
  });

  it('defaults the idle TTL to the value of 600s for every service', () => {
    for (const service of MODEL_CACHE_SERVICES) {
      const key = `${service}.modelCache.ttlSeconds` as ServiceRuntimeKey;
      expect(SERVICE_RUNTIME_DEFAULTS[key]).toBe(600);
    }
  });

  it('preserves each service’s existing maxModels (behaviour-preserving)', () => {
    // Transcribed from each service's own code default — changing residency
    // limits is NOT part of the idle-TTL default change.
    expect(SERVICE_RUNTIME_DEFAULTS['stt.modelCache.maxModels']).toBe(5);
    expect(SERVICE_RUNTIME_DEFAULTS['nlp.modelCache.maxModels']).toBe(3);
    expect(SERVICE_RUNTIME_DEFAULTS['harness.modelCache.maxModels']).toBe(1);
  });

  it('marks every retention key globalOnly + system-scoped (never tenant-set)', () => {
    for (const key of Object.keys(SERVICE_RUNTIME_DEFAULTS).filter((k) => k.includes('.modelCache.'))) {
      const descriptor = registryByKey.get(key);
      expect(descriptor, key).toBeDefined();
      expect(descriptor!.globalOnly, key).toBe(true);
      expect(descriptor!.maxScope, key).toBe('system');
      expect(descriptor!.tier, key).toBe('global-kv');
      expect(descriptor!.dataType, key).toBe('number');
    }
  });

  it('documents the [60,3600] clamp on every ttlSeconds descriptor', () => {
    // The service re-applies the clamp too (defense in depth) — but an operator
    // reading the console must be told, or an out-of-range value looks accepted.
    for (const service of MODEL_CACHE_SERVICES) {
      const descriptor = registryByKey.get(`${service}.modelCache.ttlSeconds`);
      expect(descriptor!.description).toMatch(/60/);
      expect(descriptor!.description).toMatch(/3600/);
    }
  });

  it('keeps every registry key unique (no duplicate registration)', () => {
    const keys = DESCRIPTORS.map((d) => d.key);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('does NOT introduce a competing models.retention.* namespace', () => {
    // Two key families for one knob is the redundancy the Completion & Cleanup
    // Doctrine forbids.
    expect(DESCRIPTORS.filter((d) => d.key.startsWith('models.retention.'))).toEqual([]);
  });
});
