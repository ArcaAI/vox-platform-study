/**
 * TASK-1055 follow-up (D2, the reverse duplicate) — the clinical NER callers send
 * `model_path` beside `model_name`.
 *
 * `apps/nlp` caches token classifiers by `(model_name, model_path)`. The residency
 * load (`residency-load-spec.builder.ts`) and the agent-invocation path send both,
 * with `model_path = derivedLocalPath(row)`; the clinical callers sent the name
 * only, so whichever loaded first created a copy the other could not recognise.
 * The injection now carries the SAME derivation, and omits the key — never sends
 * `null` — when the row has no published path.
 */
import { describe, it, expect, vi } from 'vitest';
import { Logger } from '@nestjs/common';
import { derivedLocalPath } from '../../../ai-model/constants';
import { resolveNerModelInjection } from '../resolveNerModelSelection';
import { NlpExtractionTool } from '../../live-documentation/live-tool-registry';

function cls() {
  const store = new Map<string, unknown>([['tenantId', 'tenant-real']]);
  return {
    run: vi.fn((callback: () => unknown) => callback()),
    set: vi.fn((key: string, value: unknown) => store.set(key, value)),
    get: vi.fn((key: string) => store.get(key)),
  };
}

function routing(model: Record<string, unknown>) {
  return { resolveDefault: vi.fn().mockResolvedValue({ model }) };
}

const logger = new Logger('test');

const PUBLISHED_DIR_ROW = {
  sourceUri: 'blaze999/Medical-NER',
  bucketPrefix: 'nlp/medical-ner',
  primaryObject: 'model.safetensors',
  libraryName: 'transformers',
};

const PUBLISHED_FILE_ROW = {
  sourceUri: 'acme/ner-onnx',
  bucketPrefix: 'nlp/ner-onnx',
  primaryObject: 'model.onnx',
  libraryName: 'onnxruntime',
};

describe('resolveNerModelInjection — model_path (TASK-1055 follow-up)', () => {
  it('sends model_path = derivedLocalPath(row) for a published directory checkpoint', async () => {
    const result = await resolveNerModelInjection(routing(PUBLISHED_DIR_ROW) as any, cls() as any, logger);

    expect(derivedLocalPath(PUBLISHED_DIR_ROW)).toBeTruthy();
    expect(result).toEqual({ model_name: 'blaze999/Medical-NER', model_path: derivedLocalPath(PUBLISHED_DIR_ROW) });
  });

  it('uses the same single-file derivation the residency builder uses', async () => {
    const result = await resolveNerModelInjection(routing(PUBLISHED_FILE_ROW) as any, cls() as any, logger);

    expect(result.model_path).toBe(derivedLocalPath(PUBLISHED_FILE_ROW));
    expect(result.model_path).toMatch(/model\.onnx$/);
  });

  it('omits model_path entirely when the row has no published path (name only, unchanged)', async () => {
    const result = await resolveNerModelInjection(routing({ sourceUri: 'blaze999/Medical-NER' }) as any, cls() as any, logger);

    expect(result).toEqual({ model_name: 'blaze999/Medical-NER' });
    expect('model_path' in result).toBe(false);
  });

  it('keeps clinical_taxonomy alongside model_path', async () => {
    const clinicalTaxonomy = { assertion: { triggers: { ABSENT: ['denies'] } } };
    const result = await resolveNerModelInjection(routing({ ...PUBLISHED_DIR_ROW, metaData: { clinicalTaxonomy } }) as any, cls() as any, logger);

    expect(result).toEqual({
      model_name: 'blaze999/Medical-NER',
      model_path: derivedLocalPath(PUBLISHED_DIR_ROW),
      clinical_taxonomy: clinicalTaxonomy,
    });
  });
});

describe('NlpExtractionTool — live-plane NER body (TASK-1055 follow-up)', () => {
  function tool(model: Record<string, unknown>) {
    const post = vi.fn().mockResolvedValue({ data: { entities: [] } });
    const instance = new NlpExtractionTool({
      httpService: { axiosRef: { post } } as any,
      nlpServiceUrl: 'http://nlp:8864',
      logger,
      cls: cls() as any,
      routingPolicies: routing(model) as any,
    });
    return { instance, post };
  }

  it('posts model_path with model_name when the elected row is published', async () => {
    const { instance, post } = tool(PUBLISHED_DIR_ROW);

    await instance.execute({ sourceText: 'Patient denies chest pain', tenantId: 'tenant-real' } as any);

    expect(post).toHaveBeenCalledTimes(1);
    expect(post.mock.calls[0][0]).toBe('http://nlp:8864/api/v1/classify/tokens');
    expect(post.mock.calls[0][1]).toEqual({
      text: 'Patient denies chest pain',
      model_name: 'blaze999/Medical-NER',
      model_path: derivedLocalPath(PUBLISHED_DIR_ROW),
    });
  });

  it('posts the name only when the elected row has no published path', async () => {
    const { instance, post } = tool({ sourceUri: 'blaze999/Medical-NER' });

    await instance.execute({ sourceText: 'x', tenantId: 'tenant-real' } as any);

    expect(post.mock.calls[0][1]).toEqual({ text: 'x', model_name: 'blaze999/Medical-NER' });
  });
});
