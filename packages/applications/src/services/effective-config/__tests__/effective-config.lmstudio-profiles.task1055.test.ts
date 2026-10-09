// TASK-1055 wave 3 (G1, contract `wave3.lmStudioOnDemand.effectiveConfig`) — the LM Studio plan
// gains `profiles`: one resolved entry for EVERY enabled SYSTEM lm-studio AiModel row, with the
// same resolver as `preload` (`lmStudioPreloadEntryFor`). The agent loads an on-request model
// with that profile instead of LM Studio's own JIT defaults. `preload` is unchanged.

import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiModelRepository } from '@arcaai/domains';
import type { EffectiveSettingsService } from '../../settings-registry/effective-settings.service';
import type { IProviderConnectionService } from '../../ai-provider-connection/IProviderConnectionService';
import { HOPE_SETTINGS_REGISTRY } from '../../settings-registry/registry';
import { EffectiveConfigService } from '../effective-config.service';

const SYSTEM = '00000000-0000-0000-0000-000000000000';
const contract = JSON.parse(
  readFileSync(resolve(__dirname, '../../../../../../tests/contracts/model-residency-task1055.fixture.json'), 'utf8'),
);
const WAVE3_PLAN = contract.wave3.lmStudioOnDemand.effectiveConfig.lmStudioServing;

/** The contract's platform defaults (context 32768, parallel 10, GPU 1, q4_0 KV). */
const CONTRACT_SETTINGS: Record<string, unknown> = {
  'lmStudio.serving.contextLength': 32768,
  'lmStudio.serving.parallel': 10,
  'lmStudio.serving.gpu': 1,
  'lmStudio.serving.flashAttention': true,
  'lmStudio.serving.kvCacheQuantK': 'q4_0',
  'lmStudio.serving.kvCacheQuantV': 'q4_0',
  'lmStudio.serving.preload': ['lms-gemma-4-e2b-it-qat'],
};

function settingsStub(overrides: Record<string, unknown> = CONTRACT_SETTINGS) {
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

const GEMMA = {
  slug: 'lms-gemma-4-e2b-it-qat',
  sourceUri: 'gemma-4-e2b-it-qat',
  provider: 'lm-studio',
  metaData: { serving: { gpuSplit: { strategy: 'priorityOrder', priority: [1], disabledGpus: [0] } } },
};
const GRANITE = {
  slug: 'granite-guardian-4.1-8b',
  sourceUri: 'granite-guardian-4.1-8b',
  provider: 'lm-studio',
  metaData: {
    serving: {
      contextLength: 16384,
      gpuSplit: { strategy: 'priorityOrder', priority: [1], disabledGpus: [0] },
      kvCacheQuant: { k: 'q8_0', v: 'q8_0' },
    },
  },
};
// No profile of its own — placed on the platform GPU with every default.
const QWEN_GUARD = { slug: 'qwen3guard-gen-0.6b', sourceUri: 'qwen3guard-gen-0.6b', provider: 'lm-studio', metaData: {} };
// Incoherent: declares a context window larger than the one it is served with.
const BROKEN = {
  slug: 'lms-broken',
  sourceUri: 'broken-model',
  provider: 'lm-studio',
  metaData: { contextLength: 65536, serving: { contextLength: 4096 } },
};

function repoStub(enabledLmStudioRows: unknown[]) {
  const rows = [GEMMA, GRANITE, QWEN_GUARD, BROKEN];
  return {
    findBySlug: vi.fn(async (tenantId: string, slug: string) => (tenantId === SYSTEM ? (rows.find((r) => r.slug === slug) ?? null) : null)),
    findByProviderAndSourceUri: vi.fn(async () => null),
    findAll: vi.fn(async () => enabledLmStudioRows),
  } as unknown as AiModelRepository & { findAll: ReturnType<typeof vi.fn> };
}

function serviceWith(repo: AiModelRepository): EffectiveConfigService {
  const connections = { list: vi.fn(async () => []) } as unknown as IProviderConnectionService;
  return new EffectiveConfigService(settingsStub(), connections, undefined, undefined, repo);
}

describe('TASK-1055 wave 3 — service=lmstudio serves a profile for every enabled SYSTEM lm-studio model', () => {
  beforeEach(() => vi.clearAllMocks());

  it('matches the frozen contract plan exactly — defaults, preload unchanged, one profile per row', async () => {
    const response = await serviceWith(repoStub([QWEN_GUARD, GRANITE, GEMMA])).resolveForService('lmstudio');

    expect(response.lmStudioServing).toEqual(WAVE3_PLAN);
  });

  it('reads the rows as SYSTEM, provider lm-studio, ENABLED only', async () => {
    const repo = repoStub([GEMMA]);
    await serviceWith(repo).resolveForService('lmstudio');

    expect(repo.findAll).toHaveBeenCalledWith(
      expect.objectContaining({ filters: expect.objectContaining({ tenantId: SYSTEM, provider: 'lm-studio', resourceStatus: 'ENABLED' }) }),
    );
  });

  it('skips a row whose resolved profile has problems, keeping the rest', async () => {
    const response = await serviceWith(repoStub([GEMMA, BROKEN])).resolveForService('lmstudio');
    const plan = response.lmStudioServing as { profiles: { slug: string }[] };

    expect(plan.profiles.map((entry) => entry.slug)).toEqual(['gemma-4-e2b-it-qat']);
  });

  it('serves an empty profile list, never a failed pull, when the row read throws', async () => {
    const repo = repoStub([]);
    repo.findAll.mockRejectedValueOnce(new Error('db down'));
    const response = await serviceWith(repo).resolveForService('lmstudio');
    const plan = response.lmStudioServing as { preload: unknown[]; profiles: unknown[] };

    expect(plan.profiles).toEqual([]);
    expect(plan.preload).toHaveLength(1);
  });

  it('does not serve profiles to text', async () => {
    expect((await serviceWith(repoStub([GEMMA])).resolveForService('text')).lmStudioServing).toEqual({ parallel: 10 });
  });
});
