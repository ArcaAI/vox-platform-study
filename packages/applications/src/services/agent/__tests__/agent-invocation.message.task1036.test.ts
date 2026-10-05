/**
 * TASK-1036 OD-8 — the TEXT_GENERATION invocation's user turn is `message`.
 *
 * `text` stays accepted as a DEPRECATED alias for one release, and `{ variables }` alone is a
 * valid body (contract freeze, Q9). The turn is read through the contract's `readTextAgentMessage`
 * so the alias is retired in one place.
 *
 * Agents published BEFORE this ticket froze the old default `inputSchema` (`{ text, variables }`,
 * closed), so a caller sending `message` to one must not be refused by a schema that predates the
 * name: `inputProblems` validates such a body under the alias it is equivalent to.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedAgent } from '@arcaai/types';
import { AGENT_IO_DEFAULTS } from '@arcaai/workflow-contract';
import { AgentInvocationService } from '../agent-invocation.service';
import { asInputBlock } from './compose-expectations';

const TENANT = '50000000-0000-0000-0000-000000000001';
const post = vi.fn();
const httpService = { axiosRef: { post } } as never;
const configService = { get: vi.fn().mockReturnValue('http://text.test') } as never;
const enrichment = {
  applyTextRuntimeProfile: vi.fn().mockResolvedValue(undefined),
  applyTenantProviderOverrides: vi.fn().mockResolvedValue(undefined),
  applyGuardrailDecision: vi.fn((body: Record<string, unknown>) => body),
} as never;

const service = () => new AgentInvocationService(httpService, configService, enrichment);

/** The pre-1036 default every already-published agent carries frozen. */
const LEGACY_INPUT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  required: ['text'],
  properties: { text: { type: 'string', minLength: 1 }, variables: { type: 'object', additionalProperties: { type: 'string' } } },
};

function agent(inputSchema: unknown, systemPrompt = 'You are a scribe.'): ResolvedAgent {
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
      instruction: { systemPrompt },
      resolvedPrompt: { source: 'inline', content: systemPrompt },
      parameters: {},
      inputSchema,
      outputSchema: { type: 'object' },
      tools: [],
    },
    models: [],
  } as unknown as ResolvedAgent;
}

const sentPrompt = () => (post.mock.calls.at(-1)?.[1] as Record<string, unknown>).prompt;

beforeEach(() => {
  vi.clearAllMocks();
  post.mockResolvedValue({ data: { content: 'ok', provider: 'openai', model: 'gpt-x' } });
});

describe('the user turn (OD-8)', () => {
  it('reads `message`', async () => {
    await service().invokeText(agent(AGENT_IO_DEFAULTS.TEXT_GENERATION.inputSchema), TENANT, { message: 'Summarise this.' }, 'blocking');
    expect(sentPrompt()).toBe(asInputBlock('Summarise this.'));
  });

  it('still reads the deprecated `text` alias', async () => {
    await service().invokeText(agent(AGENT_IO_DEFAULTS.TEXT_GENERATION.inputSchema), TENANT, { text: 'Summarise this.' }, 'blocking');
    expect(sentPrompt()).toBe(asInputBlock('Summarise this.'));
  });

  it('runs on `{ variables }` alone — no input block', async () => {
    await service().invokeText(agent(AGENT_IO_DEFAULTS.TEXT_GENERATION.inputSchema), TENANT, { variables: { tone: 'brief' } }, 'blocking');
    expect(sentPrompt()).toBe('');
  });
});

describe('inputProblems', () => {
  const svc = service();
  it('accepts all three bodies against the new default schema', () => {
    const resolved = agent(AGENT_IO_DEFAULTS.TEXT_GENERATION.inputSchema);
    expect(svc.inputProblems(resolved, { message: 'x' })).toEqual([]);
    expect(svc.inputProblems(resolved, { text: 'x' })).toEqual([]);
    expect(svc.inputProblems(resolved, { variables: { a: 'b' } })).toEqual([]);
  });

  it('accepts `message` against a LEGACY frozen schema that only names `text`', () => {
    expect(svc.inputProblems(agent(LEGACY_INPUT_SCHEMA), { message: 'x', variables: { a: 'b' } })).toEqual([]);
  });

  it('still refuses a body with neither against the legacy schema', () => {
    expect(svc.inputProblems(agent(LEGACY_INPUT_SCHEMA), { variables: { a: 'b' } })).not.toEqual([]);
  });

  it('does not alias for an agent whose own schema declares `message` (its author meant it)', () => {
    const own = { type: 'object', additionalProperties: false, required: ['message'], properties: { message: { type: 'string', maxLength: 3 } } };
    expect(svc.inputProblems(agent(own), { message: 'too long' })).not.toEqual([]);
  });
});
