// `modelWeights` — the block a consumer was already written against.
//
// `apps/harness/src/harness/models/source_resolver.py` reads
// `snapshot.model_weights[<slug>]` for `sourceUri` / `localPath` / `checksum`,
// and that field did not exist in the TS contract at all, so the lookup could
// only ever miss and every deployment took the env branch. These tests lock the
// shape it expects, and the fail-safe posture that keeps it on its env path
// whenever resolution cannot answer.

import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { EffectiveSettingsService } from '../../settings-registry/effective-settings.service';
import type { IProviderConnectionService } from '../../ai-provider-connection/IProviderConnectionService';
import type { IAiTaskDefaultService } from '../../ai-task-default/IAiTaskDefaultService';
import type { AiModelService } from '../../stt/model/aiModel.service';
import { HOPE_SETTINGS_REGISTRY } from '../../settings-registry/registry';
import { EffectiveConfigService } from '../effective-config.service';

const MINICHECK = 'minicheck-flan-t5-large';

function settingsStub() {
  return {
    resolveEffective: vi.fn(async (key: string) => ({
      key,
      tier: 'global-kv',
      value: HOPE_SETTINGS_REGISTRY.getOrThrow(key).default,
      sourceScope: 'code-default',
    })),
  } as unknown as EffectiveSettingsService;
}

/** taskKey → selected slug. An absent key resolves to "no selection". */
function taskDefaultsStub(selections: Record<string, string | null>) {
  return {
    getEffective: vi.fn(async (taskKey: string) => ({ taskKey, modelSlug: selections[taskKey] ?? null })),
  } as unknown as IAiTaskDefaultService;
}

function modelsStub(rows: Record<string, Record<string, unknown>>) {
  return {
    getBySlug: vi.fn(async (slug: string) => rows[slug] ?? null),
  } as unknown as AiModelService;
}

function serviceWith(taskDefaults?: IAiTaskDefaultService, models?: AiModelService): EffectiveConfigService {
  const profiles = { list: vi.fn(async () => []) } as unknown as IProviderConnectionService;
  return new EffectiveConfigService(settingsStub(), profiles, taskDefaults, models);
}

describe('effective-config: modelWeights', () => {
  beforeEach(() => vi.clearAllMocks());

  it('serves harness the MiniCheck entry its resolver looks up by slug', async () => {
    // MiniCheck's selection lives under `guardrail.groundedness` — harness has
    // no task key of its own for it. A prefix-only derivation would therefore
    // never produce this entry, which is why the cross-service mapping exists.
    const svc = serviceWith(
      taskDefaultsStub({ 'guardrail.groundedness': MINICHECK }),
      modelsStub({
        [MINICHECK]: {
          slug: MINICHECK,
          sourceUri: 's3://models/minicheck',
          localPath: '/opt/hope/models/minicheck',
          checksum: 'abc123',
        },
      }),
    );

    const res = await svc.resolveForService('harness');

    expect(res.modelWeights?.[MINICHECK]).toEqual({
      sourceUri: 's3://models/minicheck',
      localPath: '/opt/hope/models/minicheck',
      checksum: 'abc123',
    });
  });

  it('normalises an absent localPath/checksum to null rather than omitting them', async () => {
    const svc = serviceWith(
      taskDefaultsStub({ 'guardrail.groundedness': MINICHECK }),
      modelsStub({ [MINICHECK]: { slug: MINICHECK, sourceUri: 'hf:nvhf/MiniCheck' } }),
    );

    const res = await svc.resolveForService('harness');
    expect(res.modelWeights?.[MINICHECK]).toEqual({ sourceUri: 'hf:nvhf/MiniCheck', localPath: null, checksum: null });
  });

  it('serves nlp the models its own task keys select', async () => {
    const svc = serviceWith(
      taskDefaultsStub({ 'nlp.ner': 'gliner-bio' }),
      modelsStub({ 'gliner-bio': { slug: 'gliner-bio', sourceUri: 'hf:urchade/gliner_bio', localPath: null, checksum: null } }),
    );

    const res = await svc.resolveForService('nlp');
    expect(res.modelWeights?.['gliner-bio']?.sourceUri).toBe('hf:urchade/gliner_bio');
  });

  it('never serves the block to text — it holds no weights, its models being remote-engine served', async () => {
    const svc = serviceWith(
      taskDefaultsStub({ 'text.finalize': 'gemma3' }),
      modelsStub({ gemma3: { slug: 'gemma3', sourceUri: 'gemma3:latest' } }),
    );

    const res = await svc.resolveForService('text');
    expect(res.modelWeights).toBeUndefined();
  });

  describe('fail-safe: a consumer must keep its bootstrap path, never lose the pull', () => {
    it('omits the block entirely when nothing resolves (rather than serving an empty map)', async () => {
      const svc = serviceWith(taskDefaultsStub({}), modelsStub({}));
      expect((await svc.resolveForService('harness')).modelWeights).toBeUndefined();
    });

    it('omits a slug whose registry row is missing, and keeps the rest of the payload', async () => {
      const svc = serviceWith(taskDefaultsStub({ 'guardrail.groundedness': MINICHECK }), modelsStub({}));
      const res = await svc.resolveForService('harness');

      expect(res.modelWeights).toBeUndefined();
      expect(res.retention?.ttlSeconds).toBe(600);
    });

    it('degrades — never throws — when the task-default resolver fails', async () => {
      const throwing = {
        getEffective: vi.fn(async () => {
          throw new Error('cascade unavailable');
        }),
      } as unknown as IAiTaskDefaultService;

      const res = await serviceWith(throwing, modelsStub({})).resolveForService('harness');
      expect(res.modelWeights).toBeUndefined();
      expect(res.service).toBe('harness');
    });

    it('omits the block when the resolvers are not wired at all (unchanged pre-existing behaviour)', async () => {
      const res = await serviceWith().resolveForService('harness');
      expect(res.modelWeights).toBeUndefined();
    });
  });
});
