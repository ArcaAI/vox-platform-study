// Retention descriptor contract tests.
//
// The key grammar `<svc>.modelCache.<knob>` covers all five in-process
// services under one family rather than introducing a second, parallel
// `models.retention.*` namespace.

import { describe, expect, it } from 'vitest';
import { HOPE_SETTINGS_REGISTRY } from '../registry';
import { MODEL_CACHE_SERVICES, SERVICE_RUNTIME_DEFAULTS, ServiceRuntimeKey } from '../descriptors/service-runtime.descriptors';

const DESCRIPTORS = HOPE_SETTINGS_REGISTRY.list();
const registryByKey = new Map(DESCRIPTORS.map((d) => [d.key, d]));

describe('model-cache retention descriptors', () => {
  it('registers ttlSeconds/maxModels/vramBudgetMb for every in-process service', () => {
    for (const service of MODEL_CACHE_SERVICES) {
      for (const knob of ['ttlSeconds', 'maxModels', 'vramBudgetMb'] as const) {
        expect(registryByKey.has(`${service}.modelCache.${knob}`)).toBe(true);
      }
    }
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
    expect(SERVICE_RUNTIME_DEFAULTS['guardrail.modelCache.maxModels']).toBe(2);
    expect(SERVICE_RUNTIME_DEFAULTS['nlp.modelCache.maxModels']).toBe(3);
    expect(SERVICE_RUNTIME_DEFAULTS['harness.modelCache.maxModels']).toBe(1);
    expect(SERVICE_RUNTIME_DEFAULTS['tts.modelCache.maxModels']).toBe(2);
  });

  it('defaults vramBudgetMb to 0 (= unset / no VRAM budget)', () => {
    for (const service of MODEL_CACHE_SERVICES) {
      expect(SERVICE_RUNTIME_DEFAULTS[`${service}.modelCache.vramBudgetMb` as ServiceRuntimeKey]).toBe(0);
    }
  });

  it('marks every retention key globalOnly + system-scoped (never tenant-set)', () => {
    for (const service of MODEL_CACHE_SERVICES) {
      for (const knob of ['ttlSeconds', 'maxModels', 'vramBudgetMb'] as const) {
        const descriptor = registryByKey.get(`${service}.modelCache.${knob}`);
        expect(descriptor).toBeDefined();
        expect(descriptor!.globalOnly).toBe(true);
        expect(descriptor!.maxScope).toBe('system');
        expect(descriptor!.tier).toBe('global-kv');
        expect(descriptor!.dataType).toBe('number');
      }
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
    // Doctrine (program plan §2.5) forbids.
    expect(DESCRIPTORS.filter((d) => d.key.startsWith('models.retention.'))).toEqual([]);
  });
});
