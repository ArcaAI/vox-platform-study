/**
 * TASK-1059 C-0 / OD-5 / OD-8 / OD-9 — a business-plane invocation judges the caller's NARRATIVE
 * input (the `message` turn and long free-text variables) before it is combined with the prompt.
 * Typed values (numbers, one-word strings such as a gender, short values) are never sent. An
 * off-scope piece is left out (rendered empty); nothing in scope is a 422
 * `CONTENT_BLOCKED_NOT_MEDICAL`; no verdict is a 503 `GUARDRAIL_UNAVAILABLE`. TEXT is never called
 * on a refusal.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { HttpException } from '@nestjs/common';
import type { ResolvedAgent } from '@arcaai/types';
import { AGENT_IO_DEFAULTS } from '@arcaai/workflow-contract';
import { AgentInvocationService } from '../agent-invocation.service';
import { ContextJudgeUnavailableError, type ContextJudgeRequest, type ContextJudgeResult } from '../../guardrail-context-judge/IContextMedicalJudgeService';

const TENANT = '50000000-0000-0000-0000-000000000001';
const post = vi.fn();
const httpService = { axiosRef: { post } } as never;
const configService = { get: vi.fn().mockReturnValue('http://text.test') } as never;
const enrichment = {
  applyTextRuntimeProfile: vi.fn().mockResolvedValue(undefined),
  applyTenantProviderOverrides: vi.fn().mockResolvedValue(undefined),
} as never;

function judgeOf(offScope: (text: string) => boolean) {
  return {
    judge: vi.fn(async (request: ContextJudgeRequest): Promise<ContextJudgeResult> => {
      const verdicts = request.items.map((entry) => ({ id: entry.id, digest: 'd', inScope: !offScope(entry.text), contextType: 'clinical', confidence: 1, cached: false }));
      const inScopeIds = verdicts.filter((v) => v.inScope).map((v) => v.id);
      return { verdicts, inScopeIds, excludedIds: verdicts.filter((v) => !v.inScope).map((v) => v.id), refused: request.items.length > 0 && inScopeIds.length === 0 };
    }),
  };
}

const service = (judge: unknown) => new AgentInvocationService(httpService, configService, enrichment, undefined, undefined, undefined, judge as never);

const SYSTEM = 'Summarise for {{age}}. History: {{history}}';
function agent(): ResolvedAgent {
  return {
    agentId: 'a1',
    agentVersionId: 'a1',
    slug: 'scribe',
    versionNumber: 1,
    task: 'TEXT_GENERATION',
    tenantId: TENANT,
    source: 'tenant',
    compiledConfig: {
      task: 'TEXT_GENERATION',
      service: 'llm',
      model: { id: 'm1', slug: 'gpt-x', provider: 'openai', taskType: 'TEXT_GENERATION', wireModelId: 'gpt-x-2026' },
      fallbacks: [],
      instruction: { systemPrompt: SYSTEM },
      resolvedPrompt: { source: 'inline', content: SYSTEM },
      parameters: {},
      inputSchema: AGENT_IO_DEFAULTS.TEXT_GENERATION.inputSchema,
      outputSchema: { type: 'object' },
      tools: [],
    },
    models: [],
  } as unknown as ResolvedAgent;
}

const HISTORY = 'Known asthmatic on inhaled steroids since childhood with nocturnal cough.';
const sentBody = () => post.mock.calls.at(-1)?.[1] as Record<string, unknown>;
/** The whole composed request — system message and user turn (variables may render in either). */
const sentText = () => `${String(sentBody().system_prompt ?? '')}\n${String(sentBody().prompt ?? '')}`;

beforeEach(() => {
  vi.clearAllMocks();
  post.mockResolvedValue({ data: { content: 'ok', provider: 'openai', model: 'gpt-x' } });
});

describe('AgentInvocationService — context medical judge (TASK-1059)', () => {
  it('judges the message and free-text variables only, with the consultation from the attribution', async () => {
    const judge = judgeOf(() => false);
    await service(judge).invokeText(
      agent(),
      TENANT,
      { message: 'Patient reports wheeze at night.', variables: { age: '45', history: HISTORY } },
      'blocking',
      { attribution: { consultationId: 'c-1' } },
    );
    const sent = judge.judge.mock.calls[0]![0] as ContextJudgeRequest;
    expect(sent).toMatchObject({ tenantId: TENANT, consultationId: 'c-1' });
    expect(sent.items).toEqual([
      { id: 'input:message', kind: 'caller_input', text: 'Patient reports wheeze at night.' },
      { id: 'input:variables.history', kind: 'caller_input', text: HISTORY },
    ]);
    expect(sentText()).toContain('wheeze at night');
    expect(sentText()).toContain(HISTORY);
  });

  it('leaves an off-scope piece out of the prompt and keeps the in-scope one', async () => {
    const judge = judgeOf((text) => text.includes('football'));
    await service(judge).invokeText(
      agent(),
      TENANT,
      { message: 'Tell me about the football results from last weekend please.', variables: { age: '45', history: HISTORY } },
      'blocking',
    );
    expect(sentText()).not.toContain('football');
    expect(sentText()).toContain(HISTORY);
    expect(sentText()).toContain('45');
  });

  it('refuses with 422 CONTENT_BLOCKED_NOT_MEDICAL when no narrative input is in scope, without calling TEXT', async () => {
    const error = await service(judgeOf(() => true))
      .invokeText(agent(), TENANT, { message: 'Write me a poem about the sea.', variables: { age: '45', history: HISTORY } }, 'blocking')
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(422);
    expect((error as HttpException).getResponse()).toMatchObject({ code: 'CONTENT_BLOCKED_NOT_MEDICAL' });
    expect(post).not.toHaveBeenCalled();
  });

  it('makes no judge call when the caller sent only typed values', async () => {
    const judge = judgeOf(() => true);
    await service(judge).invokeText(agent(), TENANT, { variables: { age: '45', history: 'none' } }, 'blocking');
    expect(judge.judge.mock.calls[0]?.[0]?.items ?? []).toEqual([]);
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('fails closed with 503 GUARDRAIL_UNAVAILABLE when the judge has no verdict', async () => {
    const judge = { judge: vi.fn(async () => Promise.reject(new ContextJudgeUnavailableError())) };
    const error = await service(judge)
      .invokeText(agent(), TENANT, { message: 'Patient reports wheeze at night.', variables: { age: '45', history: HISTORY } }, 'blocking')
      .catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(HttpException);
    expect((error as HttpException).getStatus()).toBe(503);
    expect((error as HttpException).getResponse()).toMatchObject({ code: 'GUARDRAIL_UNAVAILABLE' });
    expect(post).not.toHaveBeenCalled();
  });
});
