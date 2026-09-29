/**
 * TASK-1021 (C-4) — the `apps/vllm` PLATFORM knobs, replacing TASK-1010's `asrVllm.*` family.
 *
 * Engine SIZING moved to the model row (`AiModel._metadata.serving`, D-11), so the four
 * `asrVllm.engine.*` keys are gone. What stays platform-wide is how the GPU is carved into POOLS
 * (`vllm.pools`: which kinds each pool accepts, what it pins, its VRAM budget in GiB, how many
 * engines it keeps resident) and the two truncation-heuristic thresholds, renamed `vllm.truncation.*`
 * with their defaults unchanged. Platform-only (`maxScope: 'system'`, `globalOnly: true`), served on
 * `GET /internal/effective-config?service=vllm`. Nothing here SELECTS a model — that is the agent's job.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import type { IProviderConnectionService } from '../../ai-provider-connection/IProviderConnectionService';
import { EFFECTIVE_CONFIG_SERVICES } from '../../effective-config/IEffectiveConfigService';
import { EffectiveConfigService } from '../../effective-config/effective-config.service';
import type { EffectiveSettingsService } from '../effective-settings.service';
import { VLLM_DEFAULTS, VLLM_SETTINGS } from '../descriptors/vllm.descriptors';
import { HOPE_SETTINGS_REGISTRY } from '../registry';
import { CONSUMING_DEPLOYABLES } from '../registry.types';

// Cross-language lock: `apps/vllm` `DEFAULT_POOLS` is pinned to the SAME committed fixture. The dev
// overlay runs `VLLM_POOL=asr`, so `asr` must be declared by the default — otherwise a replica that
// cannot reach the gateway at start refuses to start (PoolNotConfiguredError).
const DEFAULT_POOLS = (
  JSON.parse(readFileSync(resolve(__dirname, '../../../../../../tests/contracts/vllm-default-pools.fixture.json'), 'utf8')) as {
    pools: { default: Record<string, unknown>; asr: Record<string, unknown> };
  }
).pools;

const EXPECTED_DEFAULTS: Record<string, unknown> = {
  'vllm.pools': DEFAULT_POOLS,
  // Unchanged from the `asrVllm.truncation.*` keys they replace.
  'vllm.truncation.minCharsPerVoicedSecond': 3.0,
  'vllm.truncation.voicedDbfs': -40.0,
};

const validate = (key: string, value: unknown) => HOPE_SETTINGS_REGISTRY.getOrThrow(key).validate?.(value);
const pools = (pool: Record<string, unknown>) => ({ default: { ...DEFAULT_POOLS.default, ...pool } });

describe('vllm descriptors (TASK-1021 C-4)', () => {
  it('registers exactly the three keys with the contract defaults', () => {
    expect(VLLM_DEFAULTS).toEqual(EXPECTED_DEFAULTS);
    expect(VLLM_SETTINGS.map((d) => d.key).sort()).toEqual(Object.keys(EXPECTED_DEFAULTS).sort());
    for (const [key, value] of Object.entries(EXPECTED_DEFAULTS)) {
      expect(HOPE_SETTINGS_REGISTRY.get(key)?.default, key).toEqual(value);
    }
  });

  it('the asrVllm.* keys are gone from the registry', () => {
    const retired = HOPE_SETTINGS_REGISTRY.list().filter((d) => d.key.startsWith('asrVllm.'));
    expect(retired.map((d) => d.key)).toEqual([]);
  });

  it('every key is a SYSTEM-only, platform-admin, global-kv, open-to-default knob consumed by vllm alone', () => {
    for (const descriptor of VLLM_SETTINGS) {
      expect(descriptor, descriptor.key).toMatchObject({
        tier: 'global-kv',
        maxScope: 'system',
        globalOnly: true,
        failMode: 'open-to-default',
        sensitivity: 'internal',
        consumedBy: ['vllm'],
      });
      expect(descriptor.killSwitch, descriptor.key).toBeUndefined();
      expect(descriptor.envOverride, descriptor.key).toBeUndefined();
    }
    expect(HOPE_SETTINGS_REGISTRY.getOrThrow('vllm.pools').dataType).toBe('json');
  });

  it('declares the dev overlay`s asr pool in the default, identical to the fixture', () => {
    expect(DEFAULT_POOLS.asr).toEqual({ acceptedKinds: ['asr'], pins: [], vramBudgetGiB: 6, maxResidentEngines: 1, inflightFactor: 2 });
    expect(Object.keys(VLLM_DEFAULTS['vllm.pools']).sort()).toEqual(['asr', 'default']);
  });

  it('the default vllm.pools passes its own validator', () => {
    expect(validate('vllm.pools', DEFAULT_POOLS)).toBeUndefined();
  });

  it('accepts several pools, every kind, pins, and an omitted inflightFactor', () => {
    const { inflightFactor: _omitted, ...noFactor } = DEFAULT_POOLS.default;
    expect(
      validate('vllm.pools', {
        default: noFactor,
        llm: { acceptedKinds: ['llm', 'tts'], pins: ['gemma-3-12b'], vramBudgetGiB: 10.5, maxResidentEngines: 2, inflightFactor: 3 },
      }),
    ).toBeUndefined();
  });

  it('rejects vramBudgetGiB: 0', () => {
    expect(validate('vllm.pools', pools({ vramBudgetGiB: 0 }))).toEqual(expect.stringContaining('vramBudgetGiB'));
  });

  it("rejects acceptedKinds: ['video']", () => {
    expect(validate('vllm.pools', pools({ acceptedKinds: ['video'] }))).toEqual(expect.stringContaining('acceptedKinds'));
  });

  it.each([
    ['an empty acceptedKinds', { acceptedKinds: [] }, 'acceptedKinds'],
    ['a non-array pins', { pins: 'whisper' }, 'pins'],
    ['a blank pin', { pins: [''] }, 'pins'],
    ['maxResidentEngines 0', { maxResidentEngines: 0 }, 'maxResidentEngines'],
    ['a fractional maxResidentEngines', { maxResidentEngines: 1.5 }, 'maxResidentEngines'],
    ['inflightFactor below 1', { inflightFactor: 0.5 }, 'inflightFactor'],
    ['an unknown pool field', { gpuMemoryUtilization: 0.2 }, 'gpuMemoryUtilization'],
  ])('rejects %s', (_label, pool, named) => {
    expect(validate('vllm.pools', pools(pool))).toEqual(expect.stringContaining(named));
  });

  it.each([
    ['a non-object', []],
    ['null', null],
    ['no pool at all', {}],
    ['a pool that is not an object', { default: 6 }],
    ['an unsafe pool name', { 'Default Pool': DEFAULT_POOLS.default }],
  ])('rejects %s as the whole map', (_label, value) => {
    expect(validate('vllm.pools', value)).toEqual(expect.any(String));
  });

  it('keeps the truncation bounds of the keys it replaces', () => {
    expect(validate('vllm.truncation.minCharsPerVoicedSecond', 0)).toBeUndefined();
    expect(validate('vllm.truncation.minCharsPerVoicedSecond', -0.1)).toEqual(expect.any(String));
    expect(validate('vllm.truncation.minCharsPerVoicedSecond', Number.POSITIVE_INFINITY)).toEqual(expect.any(String));
    expect(validate('vllm.truncation.voicedDbfs', -90)).toBeUndefined();
    expect(validate('vllm.truncation.voicedDbfs', 0)).toBeUndefined();
    expect(validate('vllm.truncation.voicedDbfs', -90.1)).toEqual(expect.any(String));
    expect(validate('vllm.truncation.voicedDbfs', 0.1)).toEqual(expect.any(String));
  });
});

describe('vllm is a consuming deployable of the effective-config pull (TASK-1021)', () => {
  it('is named in CONSUMING_DEPLOYABLES, which IS the wire contract`s service list — and asr-vllm is not', () => {
    expect(CONSUMING_DEPLOYABLES).toContain('vllm');
    expect(EFFECTIVE_CONFIG_SERVICES).toContain('vllm');
    expect(CONSUMING_DEPLOYABLES).not.toContain('asr-vllm');
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

  it('serves service=vllm exactly the vllm.* keys, and nothing else', async () => {
    const response = await serviceWithDefaults().resolveForService('vllm');
    expect(Object.keys(response.settings ?? {}).sort()).toEqual(Object.keys(EXPECTED_DEFAULTS).sort());
    expect(response.settings?.['vllm.pools']).toEqual({ value: DEFAULT_POOLS, dataType: 'json', source: 'env-fallback' });
    expect(response).not.toHaveProperty('retention');
    expect(response).not.toHaveProperty('concurrency');
    expect(response).not.toHaveProperty('modelWeights');
  });

  it('never serves a vllm.* key to another deployable', async () => {
    const service = serviceWithDefaults();
    for (const other of CONSUMING_DEPLOYABLES.filter((name) => name !== 'vllm')) {
      const response = await service.resolveForService(other);
      const leaked = Object.keys(response.settings ?? {}).filter((key) => key.startsWith('vllm.'));
      expect(leaked, other).toEqual([]);
    }
  });
});
