/**
 * TASK-1055 follow-up (owner, 2026-10-09) — the DEFAULT GPU alignment of the five resident models:
 *
 *   GPU 0  Medical NER · GLiGuard · Whisper ML-EN (the live ASR model)
 *   GPU 1  Gemma (summarization) · Granite Guardian
 *
 * Two seed declarations carry it, and they are the same two the gateway's `makeDefault` (OD-4) writes:
 * `_metadata.residency.defaultDevice` (where a load with no `device` goes, every service) and, for an
 * LM Studio row, `_metadata.serving.gpuSplit` (where the boot plan preloads it). Static assertions over the
 * exported seed data — no database.
 */
import { describe, expect, it } from 'vitest';

import { DEFAULT_AI_MODELS, mergeSeedMetaDataForUpdate } from '../06-ai-models';

const OWNER_LAYOUT: Record<string, 'gpu0' | 'gpu1'> = {
  'medical-ner': 'gpu0',
  'gliguard-llm-guardrails-300m': 'gpu0',
  'arcaai-whisper-large-ml-en-gguf': 'gpu0',
  'lms-gemma-4-e2b-it-qat': 'gpu1',
  'granite-guardian-4.1-8b': 'gpu1',
};

type Meta = { residency?: { defaultDevice?: unknown }; serving?: { gpuSplit?: { strategy?: string; priority?: number[]; disabledGpus?: number[] } } };
const meta = (slug: string): Meta => {
  const row = DEFAULT_AI_MODELS.find((m) => m.slug === slug);
  if (!row) throw new Error(`seed row ${slug} missing`);
  return (row.metaData ?? {}) as Meta;
};

describe('TASK-1055 — the owner default GPU alignment', () => {
  it.each(Object.entries(OWNER_LAYOUT))('%s defaults to %s', (slug, device) => {
    expect(meta(slug).residency?.defaultDevice).toBe(device);
  });

  it('declares a default device on those five rows only', () => {
    const declared = DEFAULT_AI_MODELS.filter((m) => (m.metaData as Meta | undefined)?.residency?.defaultDevice !== undefined).map((m) => m.slug);
    expect(declared.sort()).toEqual(Object.keys(OWNER_LAYOUT).sort());
  });

  it('Granite Guardian is preloaded on GPU 1 only — the same split shape as Gemma', () => {
    expect(meta('granite-guardian-4.1-8b').serving?.gpuSplit).toEqual({ strategy: 'priorityOrder', priority: [1], disabledGpus: [0] });
    expect(meta('lms-gemma-4-e2b-it-qat').serving?.gpuSplit).toEqual({ strategy: 'priorityOrder', priority: [1], disabledGpus: [0] });
  });

  it('an LM Studio row`s default device and its boot split name the same card (makeDefault writes both)', () => {
    for (const slug of ['lms-gemma-4-e2b-it-qat', 'granite-guardian-4.1-8b']) {
      const { residency, serving } = meta(slug);
      expect(residency?.defaultDevice, slug).toBe(`gpu${serving?.gpuSplit?.priority?.[0]}`);
    }
  });
});

describe('TASK-1055 — a reseed never overwrites a placement an admin chose', () => {
  const seed = { residency: { defaultDevice: 'gpu0' } } as Parameters<typeof mergeSeedMetaDataForUpdate>[1];

  it('keeps the stored residency (an admin makeDefault + measured facts) and only adds keys it lacks', () => {
    const stored = { residency: { defaultDevice: 'gpu1', observedContextLength: 16384 } };
    expect(mergeSeedMetaDataForUpdate(stored, seed).residency).toEqual({ defaultDevice: 'gpu1', observedContextLength: 16384 });
  });

  it('adds the seed default to a stored residency that has none', () => {
    const stored = { residency: { observedContextLength: 8192 } };
    expect(mergeSeedMetaDataForUpdate(stored, seed).residency).toEqual({ defaultDevice: 'gpu0', observedContextLength: 8192 });
  });

  it('a row with no stored residency takes the seed`s', () => {
    expect(mergeSeedMetaDataForUpdate({}, seed).residency).toEqual({ defaultDevice: 'gpu0' });
  });
});
