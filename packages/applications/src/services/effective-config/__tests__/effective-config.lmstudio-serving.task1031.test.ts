// TASK-1031 (D-1, D-3, D-8..D-10) — the `lmStudioServing` view.
//
// ONE governed number (`lmStudio.serving.parallel`) is both LM Studio's decode
// slots per loaded model and apps/text's lm-studio concurrency. TEXT is served
// that number; the LM Studio pod is served the whole boot plan — the platform
// defaults plus every preloaded model's profile resolved model -> platform.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiModelRepository } from '@arcaai/domains';
import type { EffectiveSettingsService } from '../../settings-registry/effective-settings.service';
import type { IProviderConnectionService } from '../../ai-provider-connection/IProviderConnectionService';
import { HOPE_SETTINGS_REGISTRY } from '../../settings-registry/registry';
import { EFFECTIVE_CONFIG_SERVICES } from '../IEffectiveConfigService';
import { EffectiveConfigService } from '../effective-config.service';

const SYSTEM = '00000000-0000-0000-0000-000000000000';

/** Key -> stored platform value; absent keys resolve to the descriptor default. */
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

/** The two SYSTEM rows as `seed/ai-models/llm.ts` writes them (TASK-1031 owner layout). */
const SEEDED_ROWS = [
  {
    slug: 'lms-gemma-4-e2b-it-qat',
    sourceUri: 'gemma-4-e2b-it-qat',
    provider: 'lm-studio',
    metaData: {
      contextLength: 65536,
      serving: { contextLength: 65536, parallel: 10, gpuSplit: { strategy: 'priorityOrder', priority: [1], disabledGpus: [0] } },
    },
  },
  {
    slug: 'granite-guardian-4.1-8b',
    sourceUri: 'granite-guardian-4.1-8b',
    provider: 'lm-studio',
    metaData: {
      serving: {
        contextLength: 16384,
        parallel: 10,
        flashAttention: true,
        gpuSplit: { strategy: 'priorityOrder', priority: [0], disabledGpus: [1] },
        kvCacheQuant: { k: 'q8_0', v: 'q8_0' },
      },
    },
  },
  // A summarization-class row with NO profile of its own — inherits every default.
  { slug: 'lms-gemma-4-e4b', sourceUri: 'gemma-4-e4b-it-qat', provider: 'lm-studio', metaData: {} },
  { slug: 'azure-gpt-5.4-mini', sourceUri: 'gpt-5.4-mini', provider: 'azure', metaData: {} },
];

function repoStub(rows = SEEDED_ROWS) {
  return {
    findBySlug: vi.fn(async (tenantId: string, slug: string) => (tenantId === SYSTEM ? (rows.find((r) => r.slug === slug) ?? null) : null)),
    findByProviderAndSourceUri: vi.fn(async (tenantId: string, provider: string, sourceUri: string) =>
      tenantId === SYSTEM ? (rows.find((r) => r.provider === provider && r.sourceUri === sourceUri) ?? null) : null,
    ),
  } as unknown as AiModelRepository;
}

function serviceWith(settings = settingsStub(), repo: AiModelRepository | null = repoStub()): EffectiveConfigService {
  const connections = { list: vi.fn(async () => []) } as unknown as IProviderConnectionService;
  return new EffectiveConfigService(settings, connections, undefined, undefined, repo ?? undefined);
}

describe('TASK-1031 — lmstudio is a consuming deployable', () => {
  it('is on the wire contract`s service list', () => {
    expect(EFFECTIVE_CONFIG_SERVICES).toContain('lmstudio');
  });
});

describe('TASK-1031 — service=lmstudio: the boot serving plan', () => {
  beforeEach(() => vi.clearAllMocks());

  it('serves the platform defaults and both preloaded models, each resolved model -> platform', async () => {
    const response = await serviceWith().resolveForService('lmstudio');

    expect(response.lmStudioServing).toEqual({
      defaults: { contextLength: 65536, parallel: 8, gpu: 1, flashAttention: true, kvCacheQuant: { k: 'f16', v: 'f16' } },
      preload: [
        {
          slug: 'gemma-4-e2b-it-qat',
          contextLength: 65536,
          parallel: 10,
          flashAttention: true,
          gpuSplit: { strategy: 'priorityOrder', priority: [1], disabledGpus: [0] },
          gpu: null,
          kvCacheQuant: { k: 'f16', v: 'f16' },
        },
        {
          slug: 'granite-guardian-4.1-8b',
          contextLength: 16384,
          parallel: 10,
          flashAttention: true,
          gpuSplit: { strategy: 'priorityOrder', priority: [0], disabledGpus: [1] },
          gpu: null,
          kvCacheQuant: { k: 'q8_0', v: 'q8_0' },
        },
      ],
      // TASK-1055 wave 3 — the on-request profiles (covered in effective-config.lmstudio-profiles.task1055.test.ts).
      profiles: expect.any(Array),
    });
  });

  it('places a model with no gpuSplit of its own on the platform GPU, inheriting every default', async () => {
    const response = await serviceWith(
      settingsStub({ 'lmStudio.serving.preload': ['lms-gemma-4-e4b'], 'lmStudio.serving.gpu': 0 }),
    ).resolveForService('lmstudio');

    expect(response.lmStudioServing?.defaults.gpu).toBe(0);
    expect(response.lmStudioServing?.preload).toEqual([
      {
        slug: 'gemma-4-e4b-it-qat',
        contextLength: 65536,
        parallel: 8,
        flashAttention: true,
        gpuSplit: null,
        gpu: 0,
        kvCacheQuant: { k: 'f16', v: 'f16' },
      },
    ]);
  });

  it('follows a platform admin`s stored parallel into the defaults and every row that does not pin its own', async () => {
    const response = await serviceWith(
      settingsStub({ 'lmStudio.serving.parallel': 6, 'lmStudio.serving.preload': ['lms-gemma-4-e4b', 'granite-guardian-4.1-8b'] }),
    ).resolveForService('lmstudio');

    expect(response.lmStudioServing?.defaults.parallel).toBe(6);
    expect(response.lmStudioServing?.preload.map((entry) => [entry.slug, entry.parallel])).toEqual([
      ['gemma-4-e4b-it-qat', 6],
      ['granite-guardian-4.1-8b', 10],
    ]);
  });

  it('skips an unknown slug, a non-LM-Studio row and a duplicate — never failing the response', async () => {
    const response = await serviceWith(
      settingsStub({ 'lmStudio.serving.preload': ['no-such-model', 'azure-gpt-5.4-mini', 'granite-guardian-4.1-8b', 'granite-guardian-4.1-8b'] }),
    ).resolveForService('lmstudio');

    expect(response.lmStudioServing?.preload.map((entry) => entry.slug)).toEqual(['granite-guardian-4.1-8b']);
  });

  it('skips a model whose lookup throws, keeping the rest of the plan', async () => {
    const repo = repoStub();
    (repo.findBySlug as ReturnType<typeof vi.fn>).mockImplementation(async (_t: string, slug: string) => {
      if (slug === 'gemma-4-e2b-it-qat') throw new Error('db down');
      return SEEDED_ROWS.find((r) => r.slug === slug) ?? null;
    });

    const response = await serviceWith(settingsStub(), repo).resolveForService('lmstudio');

    expect(response.lmStudioServing?.preload.map((entry) => entry.slug)).toEqual(['granite-guardian-4.1-8b']);
  });

  it('serves the defaults with an empty preload when no model repository is wired', async () => {
    const response = await serviceWith(settingsStub(), null).resolveForService('lmstudio');
    expect(response.lmStudioServing?.defaults.parallel).toBe(8);
    expect(response.lmStudioServing?.preload).toEqual([]);
  });
});

describe('TASK-1031 — service=text: the lm-studio concurrency', () => {
  it('serves the effective lmStudio.serving.parallel, and nothing else of the plan', async () => {
    expect((await serviceWith().resolveForService('text')).lmStudioServing).toEqual({ parallel: 8 });
    expect((await serviceWith(settingsStub({ 'lmStudio.serving.parallel': 12 })).resolveForService('text')).lmStudioServing).toEqual({
      parallel: 12,
    });
  });

  it('serves no lmStudioServing block to any other deployable', async () => {
    const service = serviceWith();
    for (const other of EFFECTIVE_CONFIG_SERVICES.filter((name) => name !== 'text' && name !== 'lmstudio')) {
      expect(await service.resolveForService(other), other).not.toHaveProperty('lmStudioServing');
    }
  });
});
