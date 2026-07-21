/**
 * The gateway carries `AiModel.localPath` to NLP.
 *
 * NLP is deliberately stateless (no DB), so the registry's weight path can only
 * reach it by request injection — `_MODEL_IDENTITY_FIELDS` in
 * `nlp/core/config.py` already blocks env from setting `model_path`, making the
 * request lane the sanctioned one.
 *
 * The load-bearing guarantee here is the OMISSION case: when the registry row
 * carries no `localPath`, the upstream payload must be byte-for-byte identical
 * to today's, so this ships with zero behaviour change for every existing row.
 */
import { describe, expect, it, vi } from 'vitest';
import { AiInferenceController } from '../ai-inference.controller';

function makeController(
  aiTaskDefaults?: { getEffective: ReturnType<typeof vi.fn> },
  aiModels?: { getByTaskTypeSharedRead: ReturnType<typeof vi.fn> },
) {
  const client = { analyzeGuardrail: vi.fn(), classifyTokens: vi.fn(), suggestDiagnosis: vi.fn() };
  const controller = new AiInferenceController(client as never, aiTaskDefaults as never, aiModels as never);
  return { controller, client };
}

const effective = (taskKey: string, sourceUri: string, localPath?: string | null) => ({
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
    localPath: localPath ?? null,
  },
});

describe('TASK-527 — model_path injection (NER)', () => {
  it('injects model_path when the registry row carries a localPath', async () => {
    const aiTaskDefaults = {
      getEffective: vi.fn().mockResolvedValue(effective('nlp.ner', 'blaze999/Medical-NER', '/opt/hope/models/ner')),
    };
    const { controller, client } = makeController(aiTaskDefaults);
    client.classifyTokens.mockResolvedValue({});

    await controller.extractEntities({ text: 'aspirin 100mg' });

    expect(client.classifyTokens).toHaveBeenCalledWith({
      text: 'aspirin 100mg',
      aggregation_strategy: 'simple',
      model_name: 'blaze999/Medical-NER',
      model_path: '/opt/hope/models/ner',
    });
  });

  it('omits model_path entirely when the row has none (payload identical to pre-527)', async () => {
    const aiTaskDefaults = {
      getEffective: vi.fn().mockResolvedValue(effective('nlp.ner', 'blaze999/Medical-NER', null)),
    };
    const { controller, client } = makeController(aiTaskDefaults);
    client.classifyTokens.mockResolvedValue({});

    await controller.extractEntities({ text: 'aspirin 100mg' });

    const payload = client.classifyTokens.mock.calls[0][0];
    expect(payload).toEqual({
      text: 'aspirin 100mg',
      aggregation_strategy: 'simple',
      model_name: 'blaze999/Medical-NER',
    });
    expect(Object.keys(payload)).not.toContain('model_path');
  });

  it('omits model_path when localPath is an empty string (cleared override)', async () => {
    const aiTaskDefaults = {
      getEffective: vi.fn().mockResolvedValue(effective('nlp.ner', 'blaze999/Medical-NER', '')),
    };
    const { controller, client } = makeController(aiTaskDefaults);
    client.classifyTokens.mockResolvedValue({});

    await controller.extractEntities({ text: 'x' });

    expect(Object.keys(client.classifyTokens.mock.calls[0][0])).not.toContain('model_path');
  });
});

describe('TASK-527 — model_path injection (diagnosis)', () => {
  it('injects model_path when the diagnosis row carries a localPath', async () => {
    const aiTaskDefaults = {
      getEffective: vi.fn().mockResolvedValue(effective('nlp.diagnosis', 'some/diagnosis-model', '/opt/hope/models/dx')),
    };
    const { controller, client } = makeController(aiTaskDefaults);
    client.suggestDiagnosis.mockResolvedValue({});

    await controller.suggestDiagnosis({ text: 'chest pain' });

    expect(client.suggestDiagnosis).toHaveBeenCalledWith({
      text: 'chest pain',
      model_name: 'some/diagnosis-model',
      model_path: '/opt/hope/models/dx',
    });
  });

  it('omits model_path when the diagnosis row has none', async () => {
    const aiTaskDefaults = {
      getEffective: vi.fn().mockResolvedValue(effective('nlp.diagnosis', 'some/diagnosis-model', null)),
    };
    const { controller, client } = makeController(aiTaskDefaults);
    client.suggestDiagnosis.mockResolvedValue({});

    await controller.suggestDiagnosis({ text: 'chest pain' });

    expect(client.suggestDiagnosis).toHaveBeenCalledWith({
      text: 'chest pain',
      model_name: 'some/diagnosis-model',
    });
  });
});

describe('TASK-527 — override lane stays fail-closed', () => {
  it('a validated override forwards the matched row localPath, not a caller value', async () => {
    const aiModels = {
      getByTaskTypeSharedRead: vi.fn().mockResolvedValue([
        { slug: 'ner-alt', sourceUri: 'org/ner-alt', localPath: '/opt/hope/models/ner-alt' },
      ]),
    };
    const { controller, client } = makeController(undefined, aiModels);
    client.classifyTokens.mockResolvedValue({});

    await controller.extractEntities({ text: 'x', modelName: 'ner-alt' });

    expect(client.classifyTokens).toHaveBeenCalledWith({
      text: 'x',
      aggregation_strategy: 'simple',
      model_name: 'org/ner-alt',
      model_path: '/opt/hope/models/ner-alt',
    });
  });

  it('an override whose row has no localPath injects no model_path', async () => {
    const aiModels = {
      getByTaskTypeSharedRead: vi.fn().mockResolvedValue([
        { slug: 'ner-alt', sourceUri: 'org/ner-alt', localPath: null },
      ]),
    };
    const { controller, client } = makeController(undefined, aiModels);
    client.classifyTokens.mockResolvedValue({});

    await controller.extractEntities({ text: 'x', modelName: 'ner-alt' });

    expect(Object.keys(client.classifyTokens.mock.calls[0][0])).not.toContain('model_path');
  });
});
