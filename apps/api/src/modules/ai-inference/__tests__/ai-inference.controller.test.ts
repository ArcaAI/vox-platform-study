/**
 * AiInferenceController unit tests (TASK-446, extended TASK-506). The
 * controller maps the validated camelCase DTOs to the upstream snake_case body
 * (with defaults), resolves the tenant's default NLP model via
 * `IAiTaskDefaultService` (fail-open), and proxies the client response verbatim.
 */
import { describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { AiInferenceController } from '../ai-inference.controller';

function makeController(
  aiTaskDefaults?: { getEffective: ReturnType<typeof vi.fn> },
  aiModels?: { getByTaskTypeSharedRead: ReturnType<typeof vi.fn> },
) {
  const client = { analyzeGuardrail: vi.fn(), classifyTokens: vi.fn(), suggestDiagnosis: vi.fn() };
  const controller = new AiInferenceController(client as never, aiTaskDefaults as never, aiModels as never);
  return { controller, client };
}

const effectiveWithModel = (taskKey: string, sourceUri: string) => ({
  tenantId: 't1',
  taskKey,
  modelSlug: 'some-slug',
  source: 'system' as const,
  configJson: null,
  model: { id: 'm1', slug: 'some-slug', name: 'Some Model', provider: 'built-in', architecture: null, taskType: 'X', format: 'SAFETENSOR', sourceUri },
});

describe('AiInferenceController — guardrail', () => {
  it('maps guardrailType → guardrail_type and returns the verdict verbatim', async () => {
    const { controller, client } = makeController();
    const verdict = { safe: true, issues: [], confidence: 0.1 };
    client.analyzeGuardrail.mockResolvedValue(verdict);

    const result = await controller.analyzeGuardrail({ text: 'hello', guardrailType: 'pii_detection' });

    expect(client.analyzeGuardrail).toHaveBeenCalledWith({ text: 'hello', guardrail_type: 'pii_detection' });
    expect(result).toBe(verdict);
  });

  it('defaults guardrail_type to comprehensive when omitted', async () => {
    const { controller, client } = makeController();
    client.analyzeGuardrail.mockResolvedValue({});
    await controller.analyzeGuardrail({ text: 'hello' });
    expect(client.analyzeGuardrail).toHaveBeenCalledWith({ text: 'hello', guardrail_type: 'comprehensive' });
  });
});

describe('AiInferenceController — NER entities', () => {
  it('maps aggregationStrategy → aggregation_strategy (default simple) and omits language when absent', async () => {
    const { controller, client } = makeController();
    const entities = { entities: [], model_version: 'v1' };
    client.classifyTokens.mockResolvedValue(entities);

    const result = await controller.extractEntities({ text: 'aspirin 100mg' });

    expect(client.classifyTokens).toHaveBeenCalledWith({ text: 'aspirin 100mg', aggregation_strategy: 'simple' });
    expect(result).toBe(entities);
  });

  it('forwards language and a custom aggregation strategy when supplied', async () => {
    const { controller, client } = makeController();
    client.classifyTokens.mockResolvedValue({});
    await controller.extractEntities({ text: 'x', aggregationStrategy: 'max', language: 'vi' });
    expect(client.classifyTokens).toHaveBeenCalledWith({ text: 'x', aggregation_strategy: 'max', language: 'vi' });
  });

  // TASK-506 — the tenant's effective `nlp.ner` default (AiModel.sourceUri, an
  // HF id) is injected as `model_name` when the caller supplies none.
  it('injects model_name from the effective nlp.ner default when the caller supplies no model', async () => {
    const aiTaskDefaults = { getEffective: vi.fn().mockResolvedValue(effectiveWithModel('nlp.ner', 'blaze999/Medical-NER')) };
    const { controller, client } = makeController(aiTaskDefaults);
    client.classifyTokens.mockResolvedValue({});

    await controller.extractEntities({ text: 'x' });

    expect(aiTaskDefaults.getEffective).toHaveBeenCalledWith('nlp.ner');
    expect(client.classifyTokens).toHaveBeenCalledWith({ text: 'x', aggregation_strategy: 'simple', model_name: 'blaze999/Medical-NER' });
  });

  // r2605 Finding B (security) — a caller-supplied modelName was previously
  // forwarded UNVALIDATED, letting any authenticated user make the clinical
  // NLP service download/load an arbitrary HuggingFace model. The override
  // must now resolve against ENABLED TOKEN_CLASSIFICATION registry rows
  // (shared-read: [tenant, SYSTEM]) by slug OR sourceUri; the row's sourceUri
  // is what gets forwarded. Anything else → 400.
  describe('modelName override validation (r2605 Finding B)', () => {
    const registryRows = [
      { id: 'm1', slug: 'medical-ner', sourceUri: 'blaze999/Medical-NER', taskType: 'TOKEN_CLASSIFICATION' },
      { id: 'm2', slug: 'clinical-ner-v2', sourceUri: 'org/clinical-ner-v2', taskType: 'TOKEN_CLASSIFICATION' },
    ];

    it('a registry SLUG override is forwarded as that row sourceUri', async () => {
      const aiTaskDefaults = { getEffective: vi.fn() };
      const aiModels = { getByTaskTypeSharedRead: vi.fn().mockResolvedValue(registryRows) };
      const { controller, client } = makeController(aiTaskDefaults, aiModels);
      client.classifyTokens.mockResolvedValue({});

      await controller.extractEntities({ text: 'x', modelName: 'medical-ner' });

      expect(aiModels.getByTaskTypeSharedRead).toHaveBeenCalledWith('TOKEN_CLASSIFICATION');
      expect(aiTaskDefaults.getEffective).not.toHaveBeenCalled();
      expect(client.classifyTokens).toHaveBeenCalledWith({ text: 'x', aggregation_strategy: 'simple', model_name: 'blaze999/Medical-NER' });
    });

    it('a registry SOURCE URI override passes and forwards that sourceUri', async () => {
      const aiModels = { getByTaskTypeSharedRead: vi.fn().mockResolvedValue(registryRows) };
      const { controller, client } = makeController(undefined, aiModels);
      client.classifyTokens.mockResolvedValue({});

      await controller.extractEntities({ text: 'x', modelName: 'org/clinical-ner-v2' });

      expect(client.classifyTokens).toHaveBeenCalledWith({ text: 'x', aggregation_strategy: 'simple', model_name: 'org/clinical-ner-v2' });
    });

    it('an UNKNOWN override → 400 and nothing is forwarded upstream', async () => {
      const aiModels = { getByTaskTypeSharedRead: vi.fn().mockResolvedValue(registryRows) };
      const { controller, client } = makeController(undefined, aiModels);

      await expect(controller.extractEntities({ text: 'x', modelName: 'evil/arbitrary-model' })).rejects.toBeInstanceOf(BadRequestException);
      expect(client.classifyTokens).not.toHaveBeenCalled();
    });

    it('FAILS CLOSED: an override with no registry service wired → 400 (unlike the fail-open default injection)', async () => {
      const { controller, client } = makeController(undefined, undefined);

      await expect(controller.extractEntities({ text: 'x', modelName: 'medical-ner' })).rejects.toBeInstanceOf(BadRequestException);
      expect(client.classifyTokens).not.toHaveBeenCalled();
    });

    it('FAILS CLOSED: a registry read error under an override → 400, never an unvalidated forward', async () => {
      const aiModels = { getByTaskTypeSharedRead: vi.fn().mockRejectedValue(new Error('db down')) };
      const { controller, client } = makeController(undefined, aiModels);

      await expect(controller.extractEntities({ text: 'x', modelName: 'medical-ner' })).rejects.toBeInstanceOf(BadRequestException);
      expect(client.classifyTokens).not.toHaveBeenCalled();
    });
  });

  it('omits model_name when the effective default resolves to no model (null)', async () => {
    const aiTaskDefaults = {
      getEffective: vi.fn().mockResolvedValue({ tenantId: 't1', taskKey: 'nlp.ner', modelSlug: null, source: null, configJson: null, model: null }),
    };
    const { controller, client } = makeController(aiTaskDefaults);
    client.classifyTokens.mockResolvedValue({});

    await controller.extractEntities({ text: 'x' });

    expect(client.classifyTokens).toHaveBeenCalledWith({ text: 'x', aggregation_strategy: 'simple' });
  });

  it('FAILS OPEN when default resolution throws — forwards without model_name', async () => {
    const aiTaskDefaults = { getEffective: vi.fn().mockRejectedValue(new Error('db down')) };
    const { controller, client } = makeController(aiTaskDefaults);
    client.classifyTokens.mockResolvedValue({});

    await controller.extractEntities({ text: 'x' });

    expect(client.classifyTokens).toHaveBeenCalledWith({ text: 'x', aggregation_strategy: 'simple' });
  });

  it('works without the AiTaskDefault service wired (optional dependency)', async () => {
    const { controller, client } = makeController(undefined);
    client.classifyTokens.mockResolvedValue({});
    await controller.extractEntities({ text: 'x' });
    expect(client.classifyTokens).toHaveBeenCalledWith({ text: 'x', aggregation_strategy: 'simple' });
  });
});

describe('AiInferenceController — diagnosis suggestions (TASK-506)', () => {
  it('maps minConfidence → min_confidence, forwards language, injects model_name from nlp.classification', async () => {
    const aiTaskDefaults = { getEffective: vi.fn().mockResolvedValue(effectiveWithModel('nlp.classification', 'shanover/symps_disease_bert_v3_c41')) };
    const { controller, client } = makeController(aiTaskDefaults);
    const suggestions = { suggestions: [{ diagnosis: 'flu', confidence: 0.8 }] };
    client.suggestDiagnosis.mockResolvedValue(suggestions);

    const result = await controller.suggestDiagnosis({ text: 'fever and cough', minConfidence: 0.3, language: 'en' });

    expect(aiTaskDefaults.getEffective).toHaveBeenCalledWith('nlp.classification');
    expect(client.suggestDiagnosis).toHaveBeenCalledWith({
      text: 'fever and cough',
      min_confidence: 0.3,
      language: 'en',
      model_name: 'shanover/symps_disease_bert_v3_c41',
    });
    expect(result).toBe(suggestions);
  });

  it('omits optional fields when absent and fails open on resolution error', async () => {
    const aiTaskDefaults = { getEffective: vi.fn().mockRejectedValue(new Error('resolver down')) };
    const { controller, client } = makeController(aiTaskDefaults);
    client.suggestDiagnosis.mockResolvedValue({});

    await controller.suggestDiagnosis({ text: 'headache' });

    expect(client.suggestDiagnosis).toHaveBeenCalledWith({ text: 'headache' });
  });

  it('forwards minConfidence: 0 (falsy but valid)', async () => {
    const { controller, client } = makeController(undefined);
    client.suggestDiagnosis.mockResolvedValue({});
    await controller.suggestDiagnosis({ text: 'x', minConfidence: 0 });
    expect(client.suggestDiagnosis).toHaveBeenCalledWith({ text: 'x', min_confidence: 0 });
  });
});
