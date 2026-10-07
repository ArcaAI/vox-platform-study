/**
 * TASK-1050 W4 round 2 (README §11.3 C, OD-33) — a reseed must not undo a platform admin's guardrail edit.
 *
 * `_metadata.policy` and `_metadata.judge` are CURRENT values a platform admin edits on
 * `/guardrails/control` (W2h). `_metadata.policyDefaults` / `judgeDefaults` are seed-owned factory defaults.
 * So on UPDATE of an existing row the model phase keeps `policy` / `judge`, only ADDS the keys the seed has
 * and the row lacks (how a new criteria key or band reaches an existing database), and refreshes the two
 * `*Defaults` to the seed. Every other `_metadata` key keeps the pre-existing full-column behaviour, and the
 * create path is unchanged.
 */
import { describe, expect, it, vi } from 'vitest';

import { SYSTEM_TENANT_ID } from '../00-constants';
import { DEFAULT_AI_MODELS, mergeSeedMetaDataForUpdate, seedAiModels } from '../06-ai-models';
import type { AiModelSeed } from '../ai-models/shared';

const GRANITE = 'granite-guardian-4.1-8b';
const seedRow = (slug: string) => DEFAULT_AI_MODELS.find((m) => m.slug === slug && m.tenantId === SYSTEM_TENANT_ID)!;
const seedMeta = (slug: string) => seedRow(slug).metaData as Record<string, any>;

describe('mergeSeedMetaDataForUpdate (pure)', () => {
  const seed: NonNullable<AiModelSeed['metaData']> = {
    hubArtifact: 'org/new-artifact',
    serving: { contextLength: 16384 },
    policy: { injectionJudgeCriteria: 'SEED v2', judgeTemperature: 0.05, judgeBands: { prompt_safety: { low: 0.5, high: 0.5 } } },
    policyDefaults: { injectionJudgeCriteria: 'SEED v2', judgeTemperature: 0.05, judgeBands: { prompt_safety: { low: 0.5, high: 0.5 } } },
    judge: { protocol: 'qwen3guard_native', lanes: ['injection_judge'], tiers: { Safe: 'pass', Controversial: 'warn', Unsafe: 'flag' } },
    judgeDefaults: { protocol: 'qwen3guard_native', lanes: ['injection_judge'], tiers: { Safe: 'pass', Controversial: 'warn', Unsafe: 'flag' } },
  };

  it('keeps an admin-edited criteria value and hyper-parameter across a reseed', () => {
    const existing = { policy: { injectionJudgeCriteria: 'ADMIN EDIT', judgeTemperature: 0.2 } };
    const merged = mergeSeedMetaDataForUpdate(existing, seed) as Record<string, any>;
    expect(merged.policy.injectionJudgeCriteria).toBe('ADMIN EDIT');
    expect(merged.policy.judgeTemperature).toBe(0.2);
  });

  it('keeps an admin-edited judge declaration', () => {
    const existing = {
      judge: { protocol: 'qwen3guard_native', lanes: ['injection_judge'], tiers: { Safe: 'pass', Controversial: 'block', Unsafe: 'flag' } },
    };
    const merged = mergeSeedMetaDataForUpdate(existing, seed) as Record<string, any>;
    expect(merged.judge.tiers.Controversial).toBe('block');
  });

  it('refreshes policyDefaults and judgeDefaults to the seed values', () => {
    const existing = {
      policy: { injectionJudgeCriteria: 'ADMIN EDIT' },
      policyDefaults: { injectionJudgeCriteria: 'SEED v1' },
      judge: { protocol: 'qwen3guard_native', lanes: ['injection_judge'] },
      judgeDefaults: { protocol: 'qwen3guard_native', lanes: [] },
    };
    const merged = mergeSeedMetaDataForUpdate(existing, seed) as Record<string, any>;
    expect(merged.policyDefaults).toEqual(seed.policyDefaults);
    expect(merged.judgeDefaults).toEqual(seed.judgeDefaults);
  });

  it('adds a key the seed has and the row lacks, at the seed value (a new criteria key or band)', () => {
    const existing = { policy: { injectionJudgeCriteria: 'ADMIN EDIT' }, judge: { protocol: 'qwen3guard_native', lanes: ['injection_judge'] } };
    const merged = mergeSeedMetaDataForUpdate(existing, seed) as Record<string, any>;
    expect(merged.policy.judgeTemperature).toBe(0.05);
    expect(merged.policy.judgeBands).toEqual({ prompt_safety: { low: 0.5, high: 0.5 } });
    expect(merged.judge.tiers).toEqual(seed.judge!.tiers);
  });

  it('never deletes a key the row has and the seed does not', () => {
    const existing = { policy: { injectionJudgeCriteria: 'ADMIN EDIT', judgeMinConfidence: 0.7 } };
    const merged = mergeSeedMetaDataForUpdate(existing, seed) as Record<string, any>;
    expect(merged.policy.judgeMinConfidence).toBe(0.7);
  });

  it('takes the seed policy / judge whole when the row has none (or a malformed one)', () => {
    expect((mergeSeedMetaDataForUpdate({}, seed) as Record<string, any>).policy).toEqual(seed.policy);
    expect((mergeSeedMetaDataForUpdate({ policy: 'garbage', judge: [1] }, seed) as Record<string, any>).judge).toEqual(seed.judge);
    expect((mergeSeedMetaDataForUpdate(null, seed) as Record<string, any>).policy).toEqual(seed.policy);
  });

  it('leaves every other _metadata key on the pre-existing behaviour: the seed value wins, and a key only the row has is dropped', () => {
    const existing = { hubArtifact: 'org/old-artifact', serving: { contextLength: 4096 }, legacyNote: 'stale', policy: {} };
    const merged = mergeSeedMetaDataForUpdate(existing, seed) as Record<string, any>;
    expect(merged.hubArtifact).toBe('org/new-artifact');
    expect(merged.serving).toEqual({ contextLength: 16384 });
    expect(merged).not.toHaveProperty('legacyNote');
  });

  it('is the seed blob verbatim for a row with no stored metaData (an untouched install)', () => {
    expect(mergeSeedMetaDataForUpdate(undefined, seed)).toEqual(seed);
  });

  it('is pure: neither input is mutated, and the result shares no policy/judge object with them', () => {
    const existing = { policy: { injectionJudgeCriteria: 'ADMIN EDIT' } };
    const before = structuredClone(existing);
    const seedBefore = structuredClone(seed);
    const merged = mergeSeedMetaDataForUpdate(existing, seed) as Record<string, any>;
    expect(existing).toEqual(before);
    expect(seed).toEqual(seedBefore);
    expect(merged.policy).not.toBe(existing.policy);
    expect(merged.policy).not.toBe(seed.policy);
  });
});

describe('mergeSeedMetaDataForUpdate — labelTaxonomy thresholds (W2h round 2)', () => {
  const seed: NonNullable<AiModelSeed['metaData']> = {
    labelTaxonomy: {
      threshold: 0.5,
      benignLabels: ['benign', 'safe'],
      tasks: {
        prompt_safety: { labels: ['safe', 'unsafe'], multi_label: false },
        jailbreak_detection: { labels: ['benign', 'prompt_injection', 'roleplay_bypass'], multi_label: true, cls_threshold: 0.4 },
        response_toxicity: { labels: ['benign', 'other'], multi_label: true, cls_threshold: 0.45 },
      },
    },
    labelTaxonomyDefaults: {
      threshold: 0.5,
      benignLabels: ['benign', 'safe'],
      tasks: {
        prompt_safety: { labels: ['safe', 'unsafe'], multi_label: false },
        jailbreak_detection: { labels: ['benign', 'prompt_injection', 'roleplay_bypass'], multi_label: true, cls_threshold: 0.4 },
        response_toxicity: { labels: ['benign', 'other'], multi_label: true, cls_threshold: 0.45 },
      },
    },
  };
  const stored = {
    labelTaxonomy: {
      threshold: 0.8,
      benignLabels: ['benign'],
      tasks: {
        prompt_safety: { labels: ['safe', 'unsafe'], multi_label: true },
        jailbreak_detection: { labels: ['benign', 'prompt_injection'], multi_label: false, cls_threshold: 0.9 },
        retired_task: { labels: ['x'], cls_threshold: 0.3 },
      },
    },
    labelTaxonomyDefaults: { threshold: 0.1 },
  };
  const merged = () => mergeSeedMetaDataForUpdate(stored, seed) as Record<string, any>;

  it('keeps an admin-edited top-level threshold across a reseed', () => {
    expect(merged().labelTaxonomy.threshold).toBe(0.8);
  });

  it('keeps an admin-edited task cls_threshold across a reseed', () => {
    expect(merged().labelTaxonomy.tasks.jailbreak_detection.cls_threshold).toBe(0.9);
  });

  it('refreshes the model facts from the seed: labels, benignLabels, multi_label and the task set', () => {
    const lt = merged().labelTaxonomy;
    expect(lt.benignLabels).toEqual(['benign', 'safe']);
    expect(lt.tasks.jailbreak_detection.labels).toEqual(['benign', 'prompt_injection', 'roleplay_bypass']);
    expect(lt.tasks.jailbreak_detection.multi_label).toBe(true);
    expect(lt.tasks.prompt_safety).toEqual({ labels: ['safe', 'unsafe'], multi_label: false });
    expect(Object.keys(lt.tasks).sort()).toEqual(['jailbreak_detection', 'prompt_safety', 'response_toxicity']);
  });

  it('gives a task that is new in the seed its seed cls_threshold', () => {
    expect(merged().labelTaxonomy.tasks.response_toxicity.cls_threshold).toBe(0.45);
  });

  it('always refreshes labelTaxonomyDefaults to the seed', () => {
    expect(merged().labelTaxonomyDefaults).toEqual(seed.labelTaxonomyDefaults);
  });

  it('takes the seed taxonomy whole for a row with none, and ignores a non-numeric stored threshold', () => {
    expect((mergeSeedMetaDataForUpdate({}, seed) as Record<string, any>).labelTaxonomy).toEqual(seed.labelTaxonomy);
    const garbage = { labelTaxonomy: { threshold: 'high', tasks: { jailbreak_detection: { cls_threshold: null } } } };
    expect((mergeSeedMetaDataForUpdate(garbage, seed) as Record<string, any>).labelTaxonomy).toEqual(seed.labelTaxonomy);
  });

  it('is pure: the stored and seed taxonomies are not mutated or aliased', () => {
    const storedBefore = structuredClone(stored);
    const seedBefore = structuredClone(seed);
    const result = merged();
    expect(stored).toEqual(storedBefore);
    expect(seed).toEqual(seedBefore);
    expect(result.labelTaxonomy).not.toBe(seed.labelTaxonomy);
    expect(result.labelTaxonomy.tasks).not.toBe(seed.labelTaxonomy!.tasks);
  });
});

describe('seedAiModels uses the merge on UPDATE and is unchanged on CREATE', () => {
  type Call = { where?: { id: string }; data: Record<string, any> };

  it('keeps an admin-edited granite criterion on an existing row while refreshing its defaults', async () => {
    const updates: Call[] = [];
    const stored = {
      ...seedMeta(GRANITE),
      policy: { ...seedMeta(GRANITE).policy, injectionJudgeCriteria: 'ADMIN EDIT' },
      policyDefaults: { injectionJudgeCriteria: 'an old default' },
    };
    const client = {
      aiModel: {
        findFirst: vi.fn(async (args: { where: { slug: string } }) =>
          args.where.slug === GRANITE ? { id: 'granite-id', metaData: stored } : { id: `id-${args.where.slug}`, metaData: null },
        ),
        update: vi.fn(async (args: Call) => {
          updates.push(args);
          return {};
        }),
        create: vi.fn(),
      },
    };
    await seedAiModels(client as never);
    const granite = updates.find((u) => u.where?.id === 'granite-id')!;
    expect(granite.data.metaData.policy.injectionJudgeCriteria).toBe('ADMIN EDIT');
    expect(granite.data.metaData.policy.unsafeContentJudgeCriteria).toBe(seedMeta(GRANITE).policy.unsafeContentJudgeCriteria);
    expect(granite.data.metaData.policyDefaults).toEqual(seedMeta(GRANITE).policyDefaults);
    expect(client.aiModel.create).not.toHaveBeenCalled();
  });

  it('keeps an edited GLiGuard threshold and cls_threshold on an existing row while refreshing labels and defaults', async () => {
    const updates: Call[] = [];
    const seeded = seedMeta('gliguard-llm-guardrails-300m');
    const stored = structuredClone(seeded);
    stored.labelTaxonomy.threshold = 0.77;
    stored.labelTaxonomy.tasks.jailbreak_detection.cls_threshold = 0.66;
    stored.labelTaxonomy.tasks.jailbreak_detection.labels = ['benign', 'stale_label'];
    stored.labelTaxonomyDefaults = { threshold: 0.1 };
    const client = {
      aiModel: {
        findFirst: vi.fn(async (args: { where: { slug: string } }) => ({
          id: `id-${args.where.slug}`,
          metaData: args.where.slug === 'gliguard-llm-guardrails-300m' ? stored : null,
        })),
        update: vi.fn(async (args: Call) => {
          updates.push(args);
          return {};
        }),
        create: vi.fn(),
      },
    };
    await seedAiModels(client as never);
    const meta = updates.find((u) => u.where?.id === 'id-gliguard-llm-guardrails-300m')!.data.metaData;
    expect(meta.labelTaxonomy.threshold).toBe(0.77);
    expect(meta.labelTaxonomy.tasks.jailbreak_detection.cls_threshold).toBe(0.66);
    expect(meta.labelTaxonomy.tasks.jailbreak_detection.labels).toEqual(seeded.labelTaxonomy.tasks.jailbreak_detection.labels);
    expect(meta.labelTaxonomyDefaults).toEqual(seeded.labelTaxonomyDefaults);
  });

  it('creates a new row with the seed metaData verbatim', async () => {
    const creates: Call[] = [];
    const client = {
      aiModel: {
        findFirst: vi.fn(async () => null),
        update: vi.fn(),
        create: vi.fn(async (args: Call) => {
          creates.push(args);
          return {};
        }),
      },
    };
    await seedAiModels(client as never);
    expect(client.aiModel.update).not.toHaveBeenCalled();
    expect(creates).toHaveLength(DEFAULT_AI_MODELS.length);
    for (const row of DEFAULT_AI_MODELS) {
      expect(creates.find((c) => c.data.slug === row.slug)?.data, row.slug).toEqual(row);
    }
  });
});
