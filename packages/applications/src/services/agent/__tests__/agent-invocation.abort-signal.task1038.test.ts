/**
 * TASK-1038 E2 (fix 4, R2) — an agent RUN's cancel and ceiling must stop the model call, so the
 * invocation service carries an optional `AbortSignal` onto the upstream request (TEXT and NLP).
 * Without one the request is unchanged.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedAgent } from '@arcaai/types';
import { AgentInvocationService } from '../agent-invocation.service';

const TENANT = '50000000-0000-0000-0000-000000000001';
const post = vi.fn();
const httpService = { axiosRef: { post } } as never;
const configService = { get: vi.fn((key: string) => (key === 'NLP_URL' ? 'http://nlp.test' : 'http://text.test')) } as never;
const enrichment = {
  applyTextRuntimeProfile: vi.fn().mockResolvedValue(undefined),
  applyTenantProviderOverrides: vi.fn().mockResolvedValue(undefined),
  applyGuardrailDecision: vi.fn((body: Record<string, unknown>) => body),
} as never;

const service = () => new AgentInvocationService(httpService, configService, enrichment);

const textAgent = {
  agentId: 'a2',
  agentVersionId: 'a2',
  slug: 'scribe',
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
    parameters: {},
    inputSchema: { type: 'object' },
    outputSchema: { type: 'string' },
    tools: [],
  },
  models: [],
  guardrail: { enabled: true },
} as unknown as ResolvedAgent;

const nerAgent = {
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
    instruction: null,
    resolvedPrompt: null,
    parameters: {},
    inputSchema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
    outputSchema: { type: 'object' },
    tools: [],
  },
  models: [{ role: 'primary', slug: 'medical-ner', sourceUri: 'blaze999/Medical-NER', provider: 'built-in', tenantId: TENANT }],
  guardrail: { enabled: true },
} as unknown as ResolvedAgent;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('the upstream request carries the run’s AbortSignal', () => {
  it('TEXT (blocking): `signal` rides on the axios config', async () => {
    post.mockResolvedValue({ data: { content: 'ok' } });
    const controller = new AbortController();
    await service().invokeText(textAgent, TENANT, { message: 'hi' }, 'blocking', { signal: controller.signal });
    expect(post.mock.calls.at(-1)?.[2]).toMatchObject({ signal: controller.signal });
  });

  it('NER: `signal` rides on the axios config', async () => {
    post.mockResolvedValue({ data: { entities: [] } });
    const controller = new AbortController();
    await service().invokeNer(nerAgent, TENANT, { text: 'chest pain' }, { signal: controller.signal });
    expect(post.mock.calls.at(-1)?.[2]).toMatchObject({ signal: controller.signal });
  });

  it('without a signal the request config carries none', async () => {
    post.mockResolvedValue({ data: { content: 'ok' } });
    await service().invokeText(textAgent, TENANT, { message: 'hi' }, 'blocking');
    expect(post.mock.calls.at(-1)?.[2]).not.toHaveProperty('signal');
  });
});
