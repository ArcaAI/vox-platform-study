// `lmStudio.serving.liveLaneQueueTimeoutSeconds`: how long apps/text lets a live-marked generation
// wait for a permit (its reserved live permit, or an idle user-lane permit it borrows) before it
// answers 503 CONCURRENCY_LIMIT. One live generation takes ~40 s on the cluster, so the old
// hardcoded 30 s refused every waiter behind a full lane. Platform-only `global-kv`, default 90,
// served to text as `lmStudioServing.liveLaneQueueTimeoutS`.
import { describe, expect, it, vi } from 'vitest';
import type { EffectiveSettingsService } from '../../settings-registry/effective-settings.service';
import type { IProviderConnectionService } from '../../ai-provider-connection/IProviderConnectionService';
import { HOPE_SETTINGS_REGISTRY } from '../../settings-registry/registry';
import {
  LM_STUDIO_LIVE_LANE_QUEUE_TIMEOUT_DEFAULT,
  LM_STUDIO_LIVE_LANE_QUEUE_TIMEOUT_KEY,
  LM_STUDIO_SERVING_DEFAULTS,
} from '../../settings-registry/descriptors/lmstudio-serving.descriptors';
import { EffectiveConfigService } from '../effective-config.service';

const KEY = 'lmStudio.serving.liveLaneQueueTimeoutSeconds';

function settingsStub(overrides: Record<string, unknown> = {}) {
  return {
    resolveEffective: vi.fn(async (key: string) => {
      const descriptor = HOPE_SETTINGS_REGISTRY.getOrThrow(key);
      return {
        key,
        tier: descriptor.tier,
        value: key in overrides ? overrides[key] : descriptor.default,
        sourceScope: key in overrides ? 'system' : 'code-default',
      };
    }),
  } as unknown as EffectiveSettingsService;
}

function serviceWith(settings: EffectiveSettingsService): EffectiveConfigService {
  const connections = { list: vi.fn(async () => []) } as unknown as IProviderConnectionService;
  return new EffectiveConfigService(settings, connections);
}

describe('the live-lane queue wait descriptor', () => {
  it('is registered as a platform-only global-kv number defaulting to 90, open-to-default', () => {
    expect(LM_STUDIO_LIVE_LANE_QUEUE_TIMEOUT_KEY).toBe(KEY);
    expect(LM_STUDIO_LIVE_LANE_QUEUE_TIMEOUT_DEFAULT).toBe(90);
    const d = HOPE_SETTINGS_REGISTRY.getOrThrow(KEY);
    expect(d.tier).toBe('global-kv');
    expect(d.dataType).toBe('number');
    expect(d.default).toBe(90);
    expect(d.maxScope).toBe('system');
    expect(d.globalOnly).toBe(true);
    expect(d.failMode).toBe('open-to-default');
    expect(d.description).toMatch(/CONCURRENCY_LIMIT/);
  });

  it('accepts 1..290 whole seconds (below the gateway TEXT timeout) and refuses anything else', () => {
    const validate = (value: unknown) => HOPE_SETTINGS_REGISTRY.getOrThrow(KEY).validate?.(value);
    expect(validate(1)).toBeUndefined();
    expect(validate(90)).toBeUndefined();
    expect(validate(290)).toBeUndefined();
    expect(validate(0)).toMatch(/whole number/);
    expect(validate(291)).toMatch(/whole number/);
    expect(validate(1.5)).toMatch(/whole number/);
    expect(validate('90')).toMatch(/whole number/);
  });

  it('is not one of the LM Studio pod`s boot-plan keys', () => {
    expect(Object.keys(LM_STUDIO_SERVING_DEFAULTS)).not.toContain(KEY);
  });
});

describe('service=text: the live-lane queue wait is served', () => {
  it('serves the default beside parallel and the live slots', async () => {
    const response = await serviceWith(settingsStub()).resolveForService('text');
    expect(response.lmStudioServing).toMatchObject({ parallel: 8, liveLaneSlots: 2, liveLaneQueueTimeoutS: 90 });
  });

  it('serves a platform admin`s stored value', async () => {
    const response = await serviceWith(settingsStub({ [KEY]: 120 })).resolveForService('text');
    expect(response.lmStudioServing).toMatchObject({ liveLaneQueueTimeoutS: 120 });
  });

  it('falls back to the default when the row is unresolved', async () => {
    const response = await serviceWith(settingsStub({ [KEY]: null })).resolveForService('text');
    expect(response.lmStudioServing).toMatchObject({ liveLaneQueueTimeoutS: 90 });
  });

  it('is not part of the LM Studio pod`s boot plan', async () => {
    const response = await serviceWith(settingsStub()).resolveForService('lmstudio');
    expect(response.lmStudioServing).not.toHaveProperty('liveLaneQueueTimeoutS');
  });
});
