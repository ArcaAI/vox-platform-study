/**
 * AI inference proxy — runtime-profile injection (TASK-524 §5 test 17).
 *
 * The distinguishing contract here is the CONTRAST in failure posture on a
 * single request:
 *   - model IDENTITY stays FAIL-CLOSED (an unresolvable default → 503), and
 *   - profile PARAMETERS are FAIL-OPEN (a throwing resolver injects nothing and
 *     the request still goes out on the NLP service's own defaults).
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AiInferenceController } from '../ai-inference.controller';

const emptyProfile = {
  provider: 'built-in',
  modelSlug: 'medical-ner',
  temperature: null,
  topP: null,
  maxTokens: null,
  contextLength: null,
  maxConcurrent: null,
  tpmLimit: null,
  rpmLimit: null,
  timeoutS: null,
  keepAliveSeconds: null,
  extraJson: null,
  isEmpty: true,
};

function effectiveWithModel(taskKey: string, sourceUri: string, provider = 'built-in') {
  return {
    tenantId: 'tnt-1',
    taskKey,
    modelSlug: 'medical-ner',
    source: 'system' as const,
    configJson: null,
    model: { slug: 'medical-ner', sourceUri, provider, taskType: 'TOKEN_CLASSIFICATION' },
  };
}

function build(profileResolver?: { resolveProfile: ReturnType<typeof vi.fn> }) {
  const client = { classifyTokens: vi.fn(async () => ({ entities: [] })), suggestDiagnosis: vi.fn(), analyzeGuardrail: vi.fn() };
  const aiTaskDefaults = { getEffective: vi.fn(async (k: string) => effectiveWithModel(k, 'hf/medical-ner')) };
  const controller = new AiInferenceController(
    client as any,
    aiTaskDefaults as any,
    undefined, // aiModelService (@Optional)
    profileResolver as any, // AiRuntimeProfileService (@Optional) — TASK-524
  );
  return { controller, client, aiTaskDefaults };
}

beforeEach(() => vi.clearAllMocks());

describe('AiInferenceController — runtime-profile injection (TASK-524)', () => {
  it('injects resolved parameters alongside model_name', async () => {
    const resolver = {
      resolveProfile: vi.fn(async () => ({ ...emptyProfile, maxConcurrent: 4, timeoutS: 30, isEmpty: false })),
    };
    const { controller, client } = build(resolver);

    await controller.extractEntities({ text: 'chest pain' } as any);

    const payload = client.classifyTokens.mock.calls[0][0];
    expect(payload.model_name).toBe('hf/medical-ner');
    expect(payload.max_concurrent).toBe(4);
    expect(payload.timeout_s).toBe(30);
  });

  it('injects nothing when the profile is empty (silent-change guard)', async () => {
    const resolver = { resolveProfile: vi.fn(async () => ({ ...emptyProfile })) };
    const { controller, client } = build(resolver);

    await controller.extractEntities({ text: 'chest pain' } as any);

    const payload = client.classifyTokens.mock.calls[0][0];
    expect(payload).toEqual({ text: 'chest pain', aggregation_strategy: 'simple', model_name: 'hf/medical-ner' });
  });

  it('injects nothing when no profile resolver is wired', async () => {
    const { controller, client } = build(undefined);

    await controller.extractEntities({ text: 'chest pain' } as any);

    const payload = client.classifyTokens.mock.calls[0][0];
    expect(payload).toEqual({ text: 'chest pain', aggregation_strategy: 'simple', model_name: 'hf/medical-ner' });
  });

  it('is FAIL-OPEN for profiles — a throwing resolver still forwards with model_name only', async () => {
    const resolver = { resolveProfile: vi.fn(async () => { throw new Error('db-down'); }) };
    const { controller, client } = build(resolver);

    await expect(controller.extractEntities({ text: 'chest pain' } as any)).resolves.toBeDefined();

    expect(client.classifyTokens).toHaveBeenCalledTimes(1);
    const payload = client.classifyTokens.mock.calls[0][0];
    expect(payload.model_name).toBe('hf/medical-ner');
    expect(payload.max_concurrent).toBeUndefined();
  });

  it('keeps model IDENTITY fail-closed even though profiles are fail-open', async () => {
    const resolver = { resolveProfile: vi.fn(async () => ({ ...emptyProfile })) };
    const { controller, client, aiTaskDefaults } = build(resolver);
    aiTaskDefaults.getEffective.mockRejectedValue(new Error('db-down'));

    const { ServiceUnavailableException } = await import('@nestjs/common');
    await expect(controller.extractEntities({ text: 'chest pain' } as any)).rejects.toBeInstanceOf(
      ServiceUnavailableException,
    );
    expect(client.classifyTokens).not.toHaveBeenCalled();
  });

  it('injects into the diagnosis route as well', async () => {
    const resolver = { resolveProfile: vi.fn(async () => ({ ...emptyProfile, timeoutS: 45, isEmpty: false })) };
    const { controller, client } = build(resolver);

    await controller.suggestDiagnosis({ text: 'fever' } as any);

    const payload = client.suggestDiagnosis.mock.calls[0][0];
    expect(payload.timeout_s).toBe(45);
  });
});
