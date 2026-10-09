// TASK-1055 wave 3 — apps/text learns the LM Studio residency agent's address from the gateway's
// effective config (`lmStudioServing.agentUrl`), never from an env var of its own: the gateway
// already holds `LMSTUDIO_AGENT_URL`, and text's env surface is the bootstrap floor only.
import { describe, expect, it, vi } from 'vitest';
import type { IConfigService } from '../../baseServices/_meta/config';
import type { EffectiveSettingsService } from '../../settings-registry/effective-settings.service';
import type { IProviderConnectionService } from '../../ai-provider-connection/IProviderConnectionService';
import { HOPE_SETTINGS_REGISTRY } from '../../settings-registry/registry';
import { EffectiveConfigService } from '../effective-config.service';

const settings = {
  resolveEffective: vi.fn(async (key: string) => {
    const descriptor = HOPE_SETTINGS_REGISTRY.getOrThrow(key);
    return { key, tier: descriptor.tier, value: descriptor.default, sourceScope: 'code-default' };
  }),
} as unknown as EffectiveSettingsService;

function serviceWith(agentUrl: string | undefined): EffectiveConfigService {
  const connections = { list: vi.fn(async () => []) } as unknown as IProviderConnectionService;
  const config = { getConfigValue: vi.fn((key: string) => (key === 'LMSTUDIO_AGENT_URL' ? agentUrl : undefined)) } as unknown as IConfigService;
  return new EffectiveConfigService(settings, connections, undefined, undefined, undefined, config);
}

describe('TASK-1055 wave 3 — service=text: the LM Studio residency agent address', () => {
  it('serves the gateway`s LMSTUDIO_AGENT_URL beside the concurrency', async () => {
    const response = await serviceWith('http://hope-lmstudio:8869/').resolveForService('text');
    expect(response.lmStudioServing).toEqual({ parallel: 10, agentUrl: 'http://hope-lmstudio:8869' });
  });

  it('omits agentUrl when the gateway has none (text then lets LM Studio JIT-load, as before)', async () => {
    expect((await serviceWith(undefined).resolveForService('text')).lmStudioServing).toEqual({ parallel: 10 });
    expect((await serviceWith('  ').resolveForService('text')).lmStudioServing).toEqual({ parallel: 10 });
  });

  it('never serves the agent address to the LM Studio pod itself', async () => {
    const response = await serviceWith('http://hope-lmstudio:8869').resolveForService('lmstudio');
    expect(response.lmStudioServing).not.toHaveProperty('agentUrl');
  });
});
