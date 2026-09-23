/**
 * TASK-1001 OD-10 — an INVOKED agent's repetition penalties reach the `/generate` body.
 *
 * `AgentInvocationService` sends `temperature`, `max_tokens` and `top_p` from the agent's
 * `parameters.generation`, and dropped `frequencyPenalty` / `presencePenalty` — both declared on
 * the same schema (`GENERATION_PROPERTY`) and both accepted at publish on a capable model. This is
 * the surface a tenant admin uses to CHECK a control they just set, so a silent drop here reads as
 * "the knob does nothing".
 *
 * Absent must mean ABSENT: TEXT applies the platform default (`text.generation.*Penalty`) only to
 * a request that omitted the field, so the service must not synthesise a `0` or send `null`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedAgent } from '@arcaai/types';
import { AgentInvocationService } from '../agent-invocation.service';
import { TextRequestEnrichmentService } from '../../text-request/text-request-enrichment.service';

const TENANT = '50000000-0000-0000-0000-000000000001';

const post = vi.fn();

const enrichment = () => new TextRequestEnrichmentService({ get: vi.fn().mockReturnValue(TENANT) } as never, undefined, undefined);

function service(): AgentInvocationService {
  return new AgentInvocationService({ axiosRef: { post } } as never, { get: vi.fn().mockReturnValue('http://text.test') } as never, enrichment());
}

function resolved(parameters: Record<string, unknown>): ResolvedAgent {
  return {
    agentId: 'a1',
    agentVersionId: 'a1',
    slug: 'arcaai-hematology-summary',
    versionNumber: 1,
    task: 'TEXT_GENERATION',
    tenantId: TENANT,
    source: 'tenant',
    compiledConfig: {
      task: 'TEXT_GENERATION',
      service: 'llm',
      model: { id: 'm1', slug: 'lms-gemma-4-e2b-it-qat', provider: 'lm-studio', taskType: 'TEXT_GENERATION', wireModelId: 'gemma-4-e2b-it-qat' },
      fallbacks: [],
      instruction: null,
      resolvedPrompt: { source: 'inline', content: 'PROMPT' },
      parameters,
      inputSchema: { type: 'object' },
      outputSchema: { type: 'string' },
      tools: [],
    },
    models: [],
    guardrail: { enabled: true },
  } as unknown as ResolvedAgent;
}

const sentBody = () => post.mock.calls.at(-1)?.[1] as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  post.mockResolvedValue({ data: { content: 'ok', provider: 'lm-studio' } });
});

describe('TASK-1001 — the invoked agent`s penalties ride `frequency_penalty` / `presence_penalty`', () => {
  it('forwards both authored penalties beside top_p', async () => {
    await service().invokeText(
      resolved({ generation: { temperature: 0, topP: 0.9, frequencyPenalty: 0.4, presencePenalty: 0.2 } }),
      TENANT,
      { text: 'hi' },
      'blocking',
    );

    expect(sentBody()).toMatchObject({ temperature: 0, top_p: 0.9, frequency_penalty: 0.4, presence_penalty: 0.2 });
  });

  it('a deliberate 0 travels — it is a value, not an absence', async () => {
    await service().invokeText(resolved({ generation: { frequencyPenalty: 0, presencePenalty: 0 } }), TENANT, { text: 'hi' }, 'blocking');

    expect(sentBody().frequency_penalty).toBe(0);
    expect(sentBody().presence_penalty).toBe(0);
  });

  it('an agent with no penalty opinion sends neither key, so TEXT applies the platform default', async () => {
    await service().invokeText(resolved({ generation: { temperature: 0.1, topP: 0.9 } }), TENANT, { text: 'hi' }, 'blocking');

    expect(Object.keys(sentBody())).not.toContain('frequency_penalty');
    expect(Object.keys(sentBody())).not.toContain('presence_penalty');
  });

  it('carries on the streaming path too', async () => {
    post.mockResolvedValue({ data: { on: () => undefined } });
    await service().invokeText(resolved({ generation: { frequencyPenalty: 0.3 } }), TENANT, { text: 'hi' }, 'stream');

    expect(sentBody().frequency_penalty).toBe(0.3);
    expect(Object.keys(sentBody())).not.toContain('presence_penalty');
  });
});
