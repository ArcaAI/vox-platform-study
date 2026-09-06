/**
 * The gateway carries the registry row's WEIGHT PATH to NLP.
 *
 * NLP is deliberately stateless (no DB), so the registry's weight path can only
 * reach it by request injection — `_MODEL_IDENTITY_FIELDS` in
 * `nlp/core/config.py` already blocks env from setting `model_path`, making the
 * request lane the sanctioned one.
 *
 * TASK-890 §3.11: the path is now DERIVED from the row's bucket identity rather
 * than read from a `localPath` column, so these fixtures supply `bucketPrefix`
 * (+ `libraryName`) and expect the derived mount path. The wire is unchanged.
 *
 * The load-bearing guarantee here is still the OMISSION case: a row with no
 * bucket identity produces a payload byte-for-byte identical to today's.
 */
import { describe, expect, it, vi } from 'vitest';
import { AiInferenceController } from '../ai-inference.controller';

function makeController(
  routingPolicies?: { resolveDefault: ReturnType<typeof vi.fn> },
  aiModels?: { getByTaskTypeSharedRead: ReturnType<typeof vi.fn> },
) {
  const client = { analyzeGuardrail: vi.fn(), classifyTokens: vi.fn(), suggestDiagnosis: vi.fn() };
  const controller = new AiInferenceController(client as never, routingPolicies as never, aiModels as never);
  return { controller, client };
}

/** `/mnt/models-bucket/<prefix>/` — what `derivedLocalPath` produces for a directory loader. */
const derived = (bucketPrefix: string) => `/mnt/models-bucket/${bucketPrefix}/`;

const effective = (taskKey: string, sourceUri: string, bucketPrefix?: string | null) => ({
  tenantId: 't1',
  taskKey,
  modelSlug: 'some-slug',
  source: 'system' as const,
  configJson: null,
  model: {
    id: 'm1',
    slug: 'some-slug',
    name: 'Some Model',
    provider: 'built-in',
    architecture: null,
    taskType: 'X',
    format: 'SAFETENSOR',
    sourceUri,
    // The bucket IDENTITY is what a row carries; the path follows from it.
    bucketPrefix: bucketPrefix || null,
    primaryObject: null,
    libraryName: 'transformers',
  },
});

describe('model_path injection (NER)', () => {
  it('injects model_path derived from the registry row bucket identity', async () => {
    const routingPolicies = {
      resolveDefault: vi.fn().mockResolvedValue(effective('nlp.ner', 'blaze999/Medical-NER', 'medical-ner/1')),
    };
    const { controller, client } = makeController(routingPolicies);
    client.classifyTokens.mockResolvedValue({});

    await controller.extractEntities({ text: 'aspirin 100mg' });

    expect(client.classifyTokens).toHaveBeenCalledWith({
      text: 'aspirin 100mg',
      model_name: 'blaze999/Medical-NER',
      model_path: derived('medical-ner/1'),
    });
  });

  it('omits model_path entirely when the row has none (payload identical to pre-527)', async () => {
    const routingPolicies = {
      resolveDefault: vi.fn().mockResolvedValue(effective('nlp.ner', 'blaze999/Medical-NER', null)),
    };
    const { controller, client } = makeController(routingPolicies);
    client.classifyTokens.mockResolvedValue({});

    await controller.extractEntities({ text: 'aspirin 100mg' });

    const payload = client.classifyTokens.mock.calls[0][0];
    expect(payload).toEqual({
      text: 'aspirin 100mg',
      model_name: 'blaze999/Medical-NER',
    });
    expect(Object.keys(payload)).not.toContain('model_path');
  });

  it('omits model_path when the bucket prefix was cleared', async () => {
    const routingPolicies = {
      resolveDefault: vi.fn().mockResolvedValue(effective('nlp.ner', 'blaze999/Medical-NER', '')),
    };
    const { controller, client } = makeController(routingPolicies);
    client.classifyTokens.mockResolvedValue({});

    await controller.extractEntities({ text: 'x' });

    expect(Object.keys(client.classifyTokens.mock.calls[0][0])).not.toContain('model_path');
  });
});

describe('model_path injection (diagnosis)', () => {
  it('injects a model_path derived from EACH diagnosis row own bucket identity', async () => {
    // The route resolves TWO keys, so each weight path must come from ITS OWN
    // registry row — a blanket mock would let one row's path satisfy both
    // assertions and hide a crossed pair.
    const routingPolicies = {
      resolveDefault: vi.fn(async (_tenantId: string, taskKey: string) =>
        taskKey === 'nlp.ner'
          ? effective('nlp.ner', 'blaze999/Medical-NER', 'medical-ner/1')
          : effective('nlp.diagnosis', 'some/diagnosis-model', 'diagnosis-model/1'),
      ),
    };
    const { controller, client } = makeController(routingPolicies);
    client.suggestDiagnosis.mockResolvedValue({});

    await controller.suggestDiagnosis({ text: 'chest pain' });

    expect(client.suggestDiagnosis).toHaveBeenCalledWith({
      text: 'chest pain',
      model_name: 'some/diagnosis-model',
      model_path: derived('diagnosis-model/1'),
      ner_model_name: 'blaze999/Medical-NER',
      ner_model_path: derived('medical-ner/1'),
    });
  });

  it('omits BOTH model_path fields when neither diagnosis row has one', async () => {
    const routingPolicies = {
      resolveDefault: vi.fn(async (_tenantId: string, taskKey: string) =>
        taskKey === 'nlp.ner'
          ? effective('nlp.ner', 'blaze999/Medical-NER', null)
          : effective('nlp.diagnosis', 'some/diagnosis-model', null),
      ),
    };
    const { controller, client } = makeController(routingPolicies);
    client.suggestDiagnosis.mockResolvedValue({});

    await controller.suggestDiagnosis({ text: 'chest pain' });

    expect(client.suggestDiagnosis).toHaveBeenCalledWith({
      text: 'chest pain',
      model_name: 'some/diagnosis-model',
      ner_model_name: 'blaze999/Medical-NER',
    });
  });
});

describe('override lane stays fail-closed', () => {
  it('a validated override forwards the MATCHED row path, derived, not a caller value', async () => {
    const aiModels = {
      getByTaskTypeSharedRead: vi
        .fn()
        .mockResolvedValue([{ slug: 'ner-alt', sourceUri: 'org/ner-alt', bucketPrefix: 'ner-alt/1', primaryObject: null, libraryName: 'transformers' }]),
    };
    const { controller, client } = makeController(undefined, aiModels);
    client.classifyTokens.mockResolvedValue({});

    await controller.extractEntities({ text: 'x', modelName: 'ner-alt' });

    expect(client.classifyTokens).toHaveBeenCalledWith({
      text: 'x',
      model_name: 'org/ner-alt',
      model_path: derived('ner-alt/1'),
    });
  });

  it('an override whose row has no bucket identity injects no model_path', async () => {
    const aiModels = {
      getByTaskTypeSharedRead: vi.fn().mockResolvedValue([{ slug: 'ner-alt', sourceUri: 'org/ner-alt', bucketPrefix: null }]),
    };
    const { controller, client } = makeController(undefined, aiModels);
    client.classifyTokens.mockResolvedValue({});

    await controller.extractEntities({ text: 'x', modelName: 'ner-alt' });

    expect(Object.keys(client.classifyTokens.mock.calls[0][0])).not.toContain('model_path');
  });
});
