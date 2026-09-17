/**
 * TASK-930 §2.4 / §5 — the NER invocation branch, and `outputSchema` as an ENGINE CONSTRAINT.
 *
 * Two behaviours are pinned here, and they are pinned on the SERVICE rather than the route
 * because every caller of this service (the route, a future job, the draft bench) must get the
 * same answer for the same reason:
 *
 *  1. a `NAMED_ENTITY_RECOGNITION` agent posts to `apps/nlp`'s `POST /api/v1/classify/tokens`
 *     with the tenant on the wire, the agent's `instruction.labels` as the extractor taxonomy
 *     and its `parameters.threshold` / `parameters.aggregation` as the two knobs that route
 *     acts on — and the wire response is mapped onto the §2.3 output schema, offsets and all,
 *     rather than relayed in `apps/nlp`'s own vocabulary;
 *  2. a TEXT_GENERATION agent that DECLARES an output schema sends it as a `json_schema`
 *     response format, unless the author set `parameters.responseFormat`, which always wins.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import type { ResolvedAgent, ResolvedAgentModel } from '@arcaai/types';
import { AgentInvocationService } from '../agent-invocation.service';

const TENANT = '50000000-0000-0000-0000-000000000001';

const post = vi.fn();
const httpService = { axiosRef: { post } } as never;
const configService = {
  get: vi.fn((key: string) => (key === 'NLP_URL' ? 'http://nlp.test' : 'http://text.test')),
} as never;
const enrichment = {
  applyTextRuntimeProfile: vi.fn().mockResolvedValue(undefined),
  applyTenantProviderOverrides: vi.fn().mockResolvedValue(undefined),
  applyGuardrailDecision: vi.fn((body: Record<string, unknown>) => body),
} as never;

function service(): AgentInvocationService {
  return new AgentInvocationService(httpService, configService, enrichment);
}

function nerPrimary(over: Partial<ResolvedAgentModel> = {}): ResolvedAgentModel {
  return {
    role: 'primary',
    slug: 'medical-ner',
    sourceUri: 'blaze999/Medical-NER',
    sourceRevision: 'main',
    localPath: '/mnt/models-bucket/medical-ner',
    wireModelId: null,
    checksum: null,
    format: 'SAFETENSOR',
    computeType: 'float32',
    provider: 'built-in',
    tenantId: '00000000-0000-0000-0000-000000000000',
    ...over,
  };
}

function nerAgent(
  over: { instruction?: Record<string, unknown> | null; parameters?: Record<string, unknown>; models?: ResolvedAgentModel[] } = {},
): ResolvedAgent {
  return {
    agentId: 'a1',
    agentVersionId: 'a1',
    slug: 'medical-ner',
    versionNumber: 1,
    task: 'NAMED_ENTITY_RECOGNITION',
    tenantId: TENANT,
    source: 'tenant',
    compiledConfig: {
      task: 'NAMED_ENTITY_RECOGNITION',
      service: null,
      model: { id: 'm1', slug: 'medical-ner', provider: 'built-in', taskType: 'TOKEN_CLASSIFICATION', wireModelId: null },
      fallbacks: [],
      instruction: over.instruction ?? null,
      resolvedPrompt: null,
      parameters: over.parameters ?? {},
      inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
      outputSchema: { type: 'object', properties: { entities: { type: 'array' } }, required: ['entities'] },
      tools: [],
    },
    models: over.models ?? [nerPrimary()],
    guardrail: { enabled: true },
  } as unknown as ResolvedAgent;
}

function textAgent(over: { parameters?: Record<string, unknown>; outputSchema?: unknown } = {}): ResolvedAgent {
  return {
    agentId: 'a2',
    agentVersionId: 'a2',
    slug: 'casenote-finalization',
    versionNumber: 1,
    task: 'TEXT_GENERATION',
    tenantId: TENANT,
    source: 'tenant',
    compiledConfig: {
      task: 'TEXT_GENERATION',
      service: 'llm',
      model: { id: 'm2', slug: 'lms-gemma', provider: 'lm-studio', taskType: 'TEXT_GENERATION', wireModelId: 'gemma-4' },
      fallbacks: [],
      instruction: null,
      resolvedPrompt: null,
      parameters: over.parameters ?? {},
      inputSchema: { type: 'object' },
      outputSchema:
        over.outputSchema ?? ({ type: 'object', properties: { case_note: { type: 'string' } }, required: ['case_note'] } as unknown),
      tools: [],
    },
    models: [],
    guardrail: { enabled: true },
  } as unknown as ResolvedAgent;
}

const sentUrl = () => post.mock.calls.at(-1)?.[0] as string;
const sentBody = () => post.mock.calls.at(-1)?.[1] as Record<string, unknown>;
const sentHeaders = () => (post.mock.calls.at(-1)?.[2] as { headers: Record<string, string> }).headers;

beforeEach(() => {
  post.mockReset();
  post.mockResolvedValue({
    data: {
      entities: [
        {
          text: 'metformin',
          entity_type: 'MEDICATION',
          confidence: 0.94,
          position: { start: 11, end: 20 },
        },
      ],
      model_version: 'blaze999/Medical-NER',
    },
  });
});

describe('TASK-930 §2.4 — invokeNer', () => {
  it('posts to the nlp token-classification route with the tenant on the wire', async () => {
    await service().invokeNer(nerAgent(), TENANT, { text: 'Prescribed metformin 500mg.' });

    expect(sentUrl()).toBe('http://nlp.test/api/v1/classify/tokens');
    expect(sentBody().text).toBe('Prescribed metformin 500mg.');
    expect(sentHeaders()['X-Tenant-Id']).toBe(TENANT);
  });

  it('sends the resolved catalogue LOCATOR as `model_name` when the row declares no wire id', async () => {
    await service().invokeNer(nerAgent(), TENANT, { text: 'x' });

    expect(sentBody().model_name).toBe('blaze999/Medical-NER');
    expect(sentBody().model_path).toBe('/mnt/models-bucket/medical-ner');
  });

  it('prefers the declared wire model id over the locator', async () => {
    await service().invokeNer(nerAgent({ models: [nerPrimary({ wireModelId: 'medical-ner-v2' })] }), TENANT, { text: 'x' });

    expect(sentBody().model_name).toBe('medical-ner-v2');
  });

  it('forwards `instruction.labels` as the extractor taxonomy and the two acted-on parameters', async () => {
    await service().invokeNer(
      nerAgent({ instruction: { labels: ['MEDICATION', 'DOSAGE'] }, parameters: { threshold: 0.6, aggregation: 'max' } }),
      TENANT,
      { text: 'x', language: 'en' },
    );

    expect(sentBody().labels).toEqual(['MEDICATION', 'DOSAGE']);
    expect(sentBody().threshold).toBe(0.6);
    expect(sentBody().aggregation_strategy).toBe('max');
    expect(sentBody().language).toBe('en');
  });

  it('omits every knob the agent did not declare, so the checkpoint’s own defaults apply', async () => {
    await service().invokeNer(nerAgent(), TENANT, { text: 'x' });

    const body = sentBody();
    expect(body).not.toHaveProperty('labels');
    expect(body).not.toHaveProperty('threshold');
    expect(body).not.toHaveProperty('aggregation_strategy');
    expect(body).not.toHaveProperty('language');
  });

  it('maps the wire entities onto the §2.3 output schema', async () => {
    const result = await service().invokeNer(nerAgent(), TENANT, { text: 'Prescribed metformin 500mg.' });

    expect(result.entities).toEqual([{ text: 'metformin', label: 'MEDICATION', start: 11, end: 20, score: 0.94 }]);
    expect(result.model).toBe('blaze999/Medical-NER');
    expect(result.charCount).toBe('Prescribed metformin 500mg.'.length);
  });

  it('drops a span the caller could not locate rather than emitting one with invented offsets', async () => {
    post.mockResolvedValue({ data: { entities: [{ text: 'metformin', entity_type: 'MEDICATION' }], model_version: 'v' } });

    const result = await service().invokeNer(nerAgent(), TENANT, { text: 'x' });

    expect(result.entities).toEqual([]);
  });

  it('refuses a non-NER agent', async () => {
    await expect(service().invokeNer(textAgent(), TENANT, { text: 'x' })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('refuses an empty body rather than posting a classification of nothing', async () => {
    await expect(service().invokeNer(nerAgent(), TENANT, {})).rejects.toBeInstanceOf(BadRequestException);
    expect(post).not.toHaveBeenCalled();
  });
});

describe('TASK-930 §5 — a declared outputSchema reaches the engine', () => {
  beforeEach(() => {
    post.mockResolvedValue({ data: { content: 'ok' } });
  });

  it('sends the declared schema as a json_schema response format', async () => {
    await service().invokeText(textAgent(), TENANT, { text: 'hi' }, 'blocking');

    expect(sentBody().response_format).toEqual({
      type: 'json_schema',
      json_schema: {
        name: 'casenote_finalization_output',
        schema: { type: 'object', properties: { case_note: { type: 'string' } }, required: ['case_note'] },
        strict: true,
      },
    });
  });

  it('yields to an explicit parameters.responseFormat', async () => {
    await service().invokeText(textAgent({ parameters: { responseFormat: 'json' } }), TENANT, { text: 'hi' }, 'blocking');

    expect(sentBody().response_format).toEqual({ type: 'json' });
  });

  it('sends nothing when the declared output is not an object schema', async () => {
    await service().invokeText(textAgent({ outputSchema: { type: 'string' } }), TENANT, { text: 'hi' }, 'blocking');

    expect(sentBody()).not.toHaveProperty('response_format');
  });
});
