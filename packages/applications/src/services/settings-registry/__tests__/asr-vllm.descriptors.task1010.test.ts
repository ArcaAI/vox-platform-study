/**
 * TASK-1010 phase B (OD-6 / OD-10) — the `apps/asr-vllm` PLATFORM knobs.
 *
 * Engine capacity (applied at the next engine build) and the vllm#53144 truncation heuristic
 * (applied per request) move off `ASR_VLLM_*` env onto `global-kv` descriptors served on
 * `GET /internal/effective-config?service=asr-vllm`. Platform-only (`maxScope: 'system'`,
 * `globalOnly: true`) by owner approval: they size a GPU pool every tenant shares, so there is
 * no tenant opinion to express. Nothing here SELECTS a model — that is the agent's job.
 */
import { describe, expect, it, vi } from 'vitest';
import type { IProviderConnectionService } from '../../ai-provider-connection/IProviderConnectionService';
import { EFFECTIVE_CONFIG_SERVICES } from '../../effective-config/IEffectiveConfigService';
import { EffectiveConfigService } from '../../effective-config/effective-config.service';
import type { EffectiveSettingsService } from '../effective-settings.service';
import { ASR_VLLM_DEFAULTS, ASR_VLLM_SETTINGS } from '../descriptors/asr-vllm.descriptors';
import { HOPE_SETTINGS_REGISTRY } from '../registry';
import { CONSUMING_DEPLOYABLES } from '../registry.types';

const EXPECTED_DEFAULTS: Record<string, unknown> = {
  'asrVllm.engine.gpuMemoryUtilization': 0.2,
  'asrVllm.engine.maxNumSeqs': 64,
  'asrVllm.engine.enforceEager': false,
  'asrVllm.engine.maxResidentEngines': 1,
  // The current `apps/asr-vllm` code defaults (`core/config.py`), so registering changes no behaviour.
  'asrVllm.truncation.minCharsPerVoicedSecond': 3.0,
  'asrVllm.truncation.voicedDbfs': -40.0,
};

const validate = (key: string, value: unknown) => HOPE_SETTINGS_REGISTRY.getOrThrow(key).validate?.(value);

describe('asr-vllm descriptors (TASK-1010)', () => {
  it('registers exactly the six keys with the plan defaults (OD-10: 0.20 of a shared 16 GB card)', () => {
    expect(ASR_VLLM_DEFAULTS).toEqual(EXPECTED_DEFAULTS);
    expect(ASR_VLLM_SETTINGS.map((d) => d.key).sort()).toEqual(Object.keys(EXPECTED_DEFAULTS).sort());
    for (const [key, value] of Object.entries(EXPECTED_DEFAULTS)) {
      expect(HOPE_SETTINGS_REGISTRY.get(key)?.default, key).toEqual(value);
    }
  });

  it('every key is a SYSTEM-only, platform-admin, global-kv, open-to-default knob consumed by asr-vllm alone', () => {
    for (const descriptor of ASR_VLLM_SETTINGS) {
      expect(descriptor, descriptor.key).toMatchObject({
        tier: 'global-kv',
        maxScope: 'system',
        globalOnly: true,
        failMode: 'open-to-default',
        sensitivity: 'internal',
        consumedBy: ['asr-vllm'],
      });
      expect(descriptor.killSwitch, descriptor.key).toBeUndefined();
      // The six `ASR_VLLM_*` tuning env vars are CLOSED, not kept as an override lane.
      expect(descriptor.envOverride, descriptor.key).toBeUndefined();
    }
  });

  it('declares the data type each value actually has', () => {
    expect(HOPE_SETTINGS_REGISTRY.getOrThrow('asrVllm.engine.enforceEager').dataType).toBe('boolean');
    for (const key of Object.keys(EXPECTED_DEFAULTS).filter((k) => k !== 'asrVllm.engine.enforceEager')) {
      expect(HOPE_SETTINGS_REGISTRY.getOrThrow(key).dataType, key).toBe('number');
    }
  });

  it('refuses out-of-range writes rather than clamping them', () => {
    expect(validate('asrVllm.engine.gpuMemoryUtilization', 0.2)).toBeUndefined();
    expect(validate('asrVllm.engine.gpuMemoryUtilization', 0.05)).toBeUndefined();
    expect(validate('asrVllm.engine.gpuMemoryUtilization', 0.95)).toBeUndefined();
    expect(validate('asrVllm.engine.gpuMemoryUtilization', 0.04)).toEqual(expect.any(String));
    expect(validate('asrVllm.engine.gpuMemoryUtilization', 0.96)).toEqual(expect.any(String));

    expect(validate('asrVllm.engine.maxNumSeqs', 1)).toBeUndefined();
    expect(validate('asrVllm.engine.maxNumSeqs', 1024)).toBeUndefined();
    expect(validate('asrVllm.engine.maxNumSeqs', 0)).toEqual(expect.any(String));
    expect(validate('asrVllm.engine.maxNumSeqs', 1025)).toEqual(expect.any(String));
    expect(validate('asrVllm.engine.maxNumSeqs', 64.5)).toEqual(expect.any(String));

    expect(validate('asrVllm.engine.maxResidentEngines', 1)).toBeUndefined();
    expect(validate('asrVllm.engine.maxResidentEngines', 4)).toBeUndefined();
    expect(validate('asrVllm.engine.maxResidentEngines', 0)).toEqual(expect.any(String));
    expect(validate('asrVllm.engine.maxResidentEngines', 5)).toEqual(expect.any(String));
    expect(validate('asrVllm.engine.maxResidentEngines', 1.5)).toEqual(expect.any(String));

    expect(validate('asrVllm.truncation.minCharsPerVoicedSecond', 0)).toBeUndefined();
    expect(validate('asrVllm.truncation.minCharsPerVoicedSecond', 2.5)).toBeUndefined();
    expect(validate('asrVllm.truncation.minCharsPerVoicedSecond', -0.1)).toEqual(expect.any(String));
    expect(validate('asrVllm.truncation.minCharsPerVoicedSecond', Number.POSITIVE_INFINITY)).toEqual(expect.any(String));

    expect(validate('asrVllm.truncation.voicedDbfs', -90)).toBeUndefined();
    expect(validate('asrVllm.truncation.voicedDbfs', 0)).toBeUndefined();
    expect(validate('asrVllm.truncation.voicedDbfs', -40.5)).toBeUndefined();
    expect(validate('asrVllm.truncation.voicedDbfs', -90.1)).toEqual(expect.any(String));
    expect(validate('asrVllm.truncation.voicedDbfs', 0.1)).toEqual(expect.any(String));
  });
});

describe('asr-vllm is a consuming deployable of the effective-config pull (TASK-1010)', () => {
  it('is named in CONSUMING_DEPLOYABLES, which IS the wire contract`s service list', () => {
    expect(CONSUMING_DEPLOYABLES).toContain('asr-vllm');
    expect(EFFECTIVE_CONFIG_SERVICES).toContain('asr-vllm');
  });

  function serviceWithDefaults(): EffectiveConfigService {
    const settings = {
      resolveEffective: vi.fn(async (key: string) => {
        const descriptor = HOPE_SETTINGS_REGISTRY.getOrThrow(key);
        return { key, tier: descriptor.tier, value: descriptor.default, sourceScope: 'code-default' };
      }),
    } as unknown as EffectiveSettingsService;
    const connections = { list: vi.fn(async () => []) } as unknown as IProviderConnectionService;
    return new EffectiveConfigService(settings, connections);
  }

  it('serves service=asr-vllm exactly the asrVllm.* keys, and nothing else', async () => {
    const response = await serviceWithDefaults().resolveForService('asr-vllm');
    expect(Object.keys(response.settings ?? {}).sort()).toEqual(Object.keys(EXPECTED_DEFAULTS).sort());
    expect(response.settings?.['asrVllm.engine.gpuMemoryUtilization']).toEqual({ value: 0.2, dataType: 'number', source: 'env-fallback' });
    expect(response.settings?.['asrVllm.engine.enforceEager']).toEqual({ value: false, dataType: 'boolean', source: 'env-fallback' });
    // No view group is invented for it: a consumer reads `settings` only.
    expect(response).not.toHaveProperty('retention');
    expect(response).not.toHaveProperty('concurrency');
    expect(response).not.toHaveProperty('modelWeights');
  });

  it('never serves an asrVllm.* key to another deployable', async () => {
    const service = serviceWithDefaults();
    for (const other of CONSUMING_DEPLOYABLES.filter((name) => name !== 'asr-vllm')) {
      const response = await service.resolveForService(other);
      const leaked = Object.keys(response.settings ?? {}).filter((key) => key.startsWith('asrVllm.'));
      expect(leaked, other).toEqual([]);
    }
  });
});
