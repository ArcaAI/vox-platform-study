// TASK-1062 D-2 A — `lmStudioServing.liveLaneSlots`: the live-documentation lane's own share of
// LM Studio's decode slots, served to apps/text beside `parallel`. Text admits generations marked
// `X-Hope-Lane: live` into a semaphore of this size and leaves the user lane `parallel - live`.
// The setting is never served above `parallel` (one setting cannot validate against another at
// write time, so the clamp lives where the two are read together).
import { describe, expect, it, vi } from 'vitest';
import type { EffectiveSettingsService } from '../../settings-registry/effective-settings.service';
import type { IProviderConnectionService } from '../../ai-provider-connection/IProviderConnectionService';
import { HOPE_SETTINGS_REGISTRY } from '../../settings-registry/registry';
import { EffectiveConfigService } from '../effective-config.service';

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

describe('TASK-1062 — service=text: the live-lane admission budget', () => {
  it('serves the default (2) beside parallel', async () => {
    const response = await serviceWith(settingsStub()).resolveForService('text');
    expect(response.lmStudioServing).toEqual({ parallel: 8, liveLaneSlots: 2, liveLaneQueueTimeoutS: 90 });
  });

  it('serves a platform admin`s stored value', async () => {
    const response = await serviceWith(settingsStub({ 'lmStudio.serving.liveLaneSlots': 3 })).resolveForService('text');
    expect(response.lmStudioServing).toMatchObject({ parallel: 8, liveLaneSlots: 3 });
  });

  it('never serves more than parallel', async () => {
    const response = await serviceWith(settingsStub({ 'lmStudio.serving.liveLaneSlots': 12, 'lmStudio.serving.parallel': 4 })).resolveForService(
      'text',
    );
    expect(response.lmStudioServing).toMatchObject({ parallel: 4, liveLaneSlots: 4 });
  });

  it('falls back to the default when the row is unresolved', async () => {
    const response = await serviceWith(settingsStub({ 'lmStudio.serving.liveLaneSlots': null })).resolveForService('text');
    expect(response.lmStudioServing).toMatchObject({ liveLaneSlots: 2 });
  });

  it('is not part of the LM Studio pod`s boot plan', async () => {
    const response = await serviceWith(settingsStub()).resolveForService('lmstudio');
    expect(response.lmStudioServing).not.toHaveProperty('liveLaneSlots');
    expect((response.lmStudioServing as { defaults: object }).defaults).not.toHaveProperty('liveLaneSlots');
  });
});
