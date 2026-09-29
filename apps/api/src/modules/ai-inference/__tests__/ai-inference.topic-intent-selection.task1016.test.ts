/**
 * TASK-1016 (OD-1a) — `/text-analyses/{topic,intent}` inject the delegated generation's selection.
 *
 * `apps/nlp` answers topic/intent by calling `text`'s `/generate`, which has no default provider or
 * model. The selection is the SYSTEM `nlp.topic` / `nlp.intent` `AiRoutingPolicy` election (both
 * keys are `nlp.*`, so platform-only: the SYSTEM tier is the only one read), injected as
 * `text_provider` (apps/text's registered name) + `text_model` (the model's wire id) the same way
 * `model_name` is injected for the encoder routes. Missing ⇒ 503 here, and NLP is never called.
 */
import { ServiceUnavailableException } from '@nestjs/common';
import { SYSTEM_TENANT_ID } from '@arcaai/domains';
import { describe, expect, it, vi } from 'vitest';
import { AiInferenceController } from '../ai-inference.controller';

const election = (provider: string | null, wireModelId: string | null) => ({
  tenantId: SYSTEM_TENANT_ID,
  taskKey: 'nlp.topic',
  source: 'system' as const,
  policy: null,
  model: {
    slug: 'lms-gemma-4-e2b-it-qat',
    provider,
    sourceUri: 'gemma-4-e2b-it-qat',
    wireModelId,
    bucketPrefix: null,
    metaData: null,
  },
});

function build(resolveDefault: ReturnType<typeof vi.fn>) {
  const client = { classifyTopic: vi.fn(async () => ({})), classifyIntent: vi.fn(async () => ({})) };
  const controller = new AiInferenceController(
    client as never,
    { resolveDefault } as never,
    { get: vi.fn((key: string) => (key === 'tenantId' ? 'tenant-1' : undefined)) } as never,
    undefined as never,
    { getRow: vi.fn(async () => ({ instructionsJson: ['billing', 'clinical'] })) } as never,
  );
  return { controller, client };
}

describe.each([
  ['classifyTopic', 'nlp.topic'],
  ['classifyIntent', 'nlp.intent'],
] as const)('%s', (method, taskKey) => {
  it(`injects the SYSTEM ${taskKey} election as text_provider + text_model`, async () => {
    const resolveDefault = vi.fn(async () => election('lm-studio', 'gemma-4-e2b-it-qat'));
    const { controller, client } = build(resolveDefault);

    await controller[method]({ text: 'hello' } as never);

    expect(resolveDefault).toHaveBeenCalledWith(SYSTEM_TENANT_ID, taskKey, { systemOnly: true });
    expect(client[method]).toHaveBeenCalledWith(
      expect.objectContaining({ tenant_id: 'tenant-1', text_provider: 'lm-studio', text_model: 'gemma-4-e2b-it-qat' }),
    );
  });

  it('names the provider the way apps/text registers it (azure → azure-openai)', async () => {
    const { controller, client } = build(vi.fn(async () => election('azure', 'gpt-4o-mini')));

    await controller[method]({ text: 'hello' } as never);

    expect(client[method]).toHaveBeenCalledWith(expect.objectContaining({ text_provider: 'azure-openai', text_model: 'gpt-4o-mini' }));
  });

  it('fails closed with 503 when the election names no model, and never calls NLP', async () => {
    const { controller, client } = build(vi.fn(async () => ({ ...election(null, null), model: null })));

    await expect(controller[method]({ text: 'hello' } as never)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(client[method]).not.toHaveBeenCalled();
  });

  it('fails closed with 503 when the elected model has no wire id', async () => {
    const { controller, client } = build(vi.fn(async () => election('lm-studio', null)));

    await expect(controller[method]({ text: 'hello' } as never)).rejects.toBeInstanceOf(ServiceUnavailableException);
    expect(client[method]).not.toHaveBeenCalled();
  });
});
