/**
 * TASK-890 F9 — an agent call puts the ROUTED model id on the wire, never the catalogue slug.
 *
 * Measured defect (2026-09-07): `POST /agents/arcaai-pre-summarization/invocations` answered 502
 * because the gateway sent `model: compiledConfig.model.slug` — `lms-gemma-4-e2b-it-qat`, the
 * HOPE catalogue key — and LM Studio answered `Invalid model identifier` (`model_not_found`).
 * The provider-native id lives on `AiModel.wireModelId` (`gemma-4-e2b-it-qat`), which is what
 * `toTextCandidate` has sent on the realtime/harness lane since §3.1 re-pointed routing off the
 * locator `sourceUri`. The invocation lane had never been repointed.
 *
 * Pinned here:
 *
 *  1. the frozen `compiledConfig.model.wireModelId` is used when the published version carries
 *     one (publish freezes it — `agent.service.test.ts`);
 *  2. a version published BEFORE the freeze still routes, off the live catalogue row the
 *     resolver materialised (`ResolvedAgent.models`) — there is no republish;
 *  3. the live row WINS when the two disagree, so a corrected `wireModelId` reaches the wire
 *     without a republish and both lanes send the same id;
 *  4. a row that declares no wire id at all is a NAMED refusal here — never a 502 relayed from
 *     an engine that was handed a name it does not know;
 *  5. TTS carries the same id, and falls back to the slug for a `built-in` row (kokoro,
 *     indic-parler) whose `wireModelId` is legitimately null and which the TTS spec routes.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { ConflictException } from '@nestjs/common';
import type { ResolvedAgent, ResolvedAgentModel } from '@arcaai/types';
import { AgentInvocationService } from '../agent-invocation.service';

const TENANT = '50000000-0000-0000-0000-000000000001';

const post = vi.fn();
const httpService = { axiosRef: { post } } as never;
const configService = { get: vi.fn().mockReturnValue('http://text.test') } as never;
const enrichment = {
  applyTextRuntimeProfile: vi.fn().mockResolvedValue(undefined),
  applyTenantProviderOverrides: vi.fn().mockResolvedValue(undefined),
  applyGuardrailDecision: vi.fn((body: Record<string, unknown>) => body),
} as never;

function service(): AgentInvocationService {
  return new AgentInvocationService(httpService, configService, enrichment);
}

function primary(wireModelId: string | null): ResolvedAgentModel {
  return {
    role: 'primary',
    slug: 'lms-gemma-4-e2b-it-qat',
    sourceUri: 'gemma-4-e2b-it-qat',
    sourceRevision: 'main',
    localPath: null,
    wireModelId,
    checksum: null,
    format: 'GGUF',
    computeType: 'q4_0',
    provider: 'lm-studio',
    tenantId: '00000000-0000-0000-0000-000000000000',
  };
}

function resolved(over: { frozen?: string | null; models?: ResolvedAgentModel[]; task?: string; parameters?: Record<string, unknown> } = {}) {
  const model: Record<string, unknown> = { id: 'm1', slug: 'lms-gemma-4-e2b-it-qat', provider: 'lm-studio', taskType: 'TEXT_GENERATION' };
  if (over.frozen !== undefined) model.wireModelId = over.frozen;
  return {
    agentId: 'a1',
    agentVersionId: 'a1',
    slug: 'arcaai-pre-summarization',
    versionNumber: 1,
    task: over.task ?? 'TEXT_GENERATION',
    tenantId: TENANT,
    source: 'tenant',
    compiledConfig: {
      task: over.task ?? 'TEXT_GENERATION',
      service: 'llm',
      model,
      fallbacks: [],
      instruction: null,
      resolvedPrompt: { source: 'inline', content: 'PROMPT' },
      parameters: over.parameters ?? {},
      inputSchema: { type: 'object' },
      outputSchema: { type: 'string' },
      tools: [],
    },
    models: over.models ?? [],
    guardrail: { enabled: true },
  } as unknown as ResolvedAgent;
}

const sentBody = () => post.mock.calls.at(-1)?.[1] as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  post.mockResolvedValue({ data: { content: 'ok', provider: 'lm-studio' } });
});

describe('the TEXT body carries the provider-native wire model id', () => {
  it('uses the wire id frozen into the compiled config, never the catalogue slug', async () => {
    await service().invokeText(resolved({ frozen: 'gemma-4-e2b-it-qat' }), TENANT, { text: 'hi' }, 'blocking');

    expect(sentBody().model).toBe('gemma-4-e2b-it-qat');
  });

  it('routes a version published before the freeze off the live catalogue row', async () => {
    await service().invokeText(resolved({ models: [primary('gemma-4-e2b-it-qat')] }), TENANT, { text: 'hi' }, 'blocking');

    expect(sentBody().model).toBe('gemma-4-e2b-it-qat');
  });

  it('lets the live catalogue row win over a stale frozen id — a corrected row needs no republish', async () => {
    await service().invokeText(resolved({ frozen: 'gemma-stale', models: [primary('gemma-4-e2b-it-qat')] }), TENANT, { text: 'hi' }, 'blocking');

    expect(sentBody().model).toBe('gemma-4-e2b-it-qat');
  });

  it('refuses with a named error when no tier declares a wire id — nothing reaches TEXT', async () => {
    const error = await service()
      .invokeText(resolved({ models: [primary(null)] }), TENANT, { text: 'hi' }, 'blocking')
      .catch((e: unknown) => e);

    expect(error).toBeInstanceOf(ConflictException);
    expect((error as ConflictException).getResponse()).toMatchObject({ code: 'AGENT_MODEL_WIRE_ID_MISSING' });
    expect(post).not.toHaveBeenCalled();
  });

  it('echoes the wire id as the result model when TEXT names none', async () => {
    const result = await service().invokeText(resolved({ frozen: 'gemma-4-e2b-it-qat' }), TENANT, { text: 'hi' }, 'blocking');

    expect(result.model).toBe('gemma-4-e2b-it-qat');
  });

  it('sends the same id on the streaming path', async () => {
    post.mockResolvedValue({ data: { on: () => undefined } });
    await service().invokeText(resolved({ models: [primary('gemma-4-e2b-it-qat')] }), TENANT, { text: 'hi' }, 'stream');

    expect(sentBody().model).toBe('gemma-4-e2b-it-qat');
  });
});

describe('the TTS body carries it too', () => {
  function speechAgent(over: { frozen?: string | null; models?: ResolvedAgentModel[]; slug?: string }): ResolvedAgent {
    const agent = resolved({ ...over, task: 'TEXT_TO_SPEECH', parameters: { voice: 'af_heart' } });
    if (over.slug) (agent.compiledConfig.model as { slug: string }).slug = over.slug;
    return agent;
  }

  it('sends the wire id for a row that declares one', () => {
    const request = service().buildSpeechRequest(speechAgent({ frozen: 'azure://neural-voices', slug: 'azure-neural-voices' }), { text: 'hello' });

    expect(request.model).toBe('azure://neural-voices');
  });

  it('falls back to the slug for a built-in row that declares none — the TTS spec routes it', () => {
    const builtIn: ResolvedAgentModel = { ...primary(null), slug: 'kokoro', provider: 'built-in' };
    const request = service().buildSpeechRequest(speechAgent({ models: [builtIn], slug: 'kokoro' }), { text: 'hello' });

    expect(request.model).toBe('kokoro');
  });
});
