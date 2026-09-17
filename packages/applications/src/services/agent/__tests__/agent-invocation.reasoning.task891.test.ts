/**
 * TASK-891 C2 (owner decision OD-4) — an INVOKED agent's reasoning posture reaches the wire too.
 *
 * Same defect as the live lane, on the surface a tenant admin uses to CHECK the control they
 * just set. `AgentInvocationService` reads the agent's `parameters.generation` (it already sends
 * `temperature`, `max_tokens` and `top_p` from it) and then called `applyTextRuntimeProfile(body)`
 * with no second argument — so the one hyper-parameter that does not have a first-class field on
 * `GenerateRequest`, and therefore travels on the `extra` ride-along, was dropped. An agent whose
 * author turned reasoning OFF still reasoned on `POST /agents/:slug/invocations`, which would
 * read as "the toggle does nothing".
 *
 * The REAL `TextRequestEnrichmentService` is used rather than the double the sibling specs
 * install, for the reason W2's live-lane spec gives: the claim is about the body that service
 * builds, so a stub would assert nothing.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedAgent } from '@arcaai/types';
import { AgentInvocationService } from '../agent-invocation.service';
import { TextRequestEnrichmentService } from '../../text-request/text-request-enrichment.service';

const TENANT = '50000000-0000-0000-0000-000000000001';

const post = vi.fn();

/** No provider-connection service and no settings resolver: this spec is about `extra` alone. */
const enrichment = () => new TextRequestEnrichmentService({ get: vi.fn().mockReturnValue(TENANT) } as never, undefined, undefined);

function service(): AgentInvocationService {
  return new AgentInvocationService({ axiosRef: { post } } as never, { get: vi.fn().mockReturnValue('http://text.test') } as never, enrichment());
}

function resolved(parameters: Record<string, unknown>): ResolvedAgent {
  return {
    agentId: 'a1',
    agentVersionId: 'a1',
    slug: 'arcaai-pre-summarization',
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

describe('TASK-891 — the invoked agent`s reasoning posture rides `reasoning`', () => {
  it('an agent that disabled reasoning instructs the engine not to reason', async () => {
    await service().invokeText(resolved({ generation: { temperature: 0.1, reasoning: { enabled: false } } }), TENANT, { text: 'hi' }, 'blocking');

    expect(sentBody().reasoning).toEqual({ enabled: false });
    // The hyper-parameters that DO have first-class fields still travel as fields. Since
    // TASK-970 so does the posture — `reasoning` is a field of its own, not a ride-along.
    expect(sentBody().temperature).toBe(0.1);
  });

  it('an agent that named an effort sends that effort', async () => {
    await service().invokeText(resolved({ generation: { reasoning: { enabled: true, effort: 'medium' } } }), TENANT, { text: 'hi' }, 'blocking');

    expect(sentBody().reasoning).toEqual({ enabled: true, effort: 'medium' });
  });

  it('an agent with no reasoning opinion sends no `reasoning` key at all', async () => {
    await service().invokeText(resolved({ generation: { temperature: 0.1 } }), TENANT, { text: 'hi' }, 'blocking');

    expect(Object.keys(sentBody())).not.toContain('reasoning');
  });

  it('carries on the streaming path too — the posture is not a blocking-mode nicety', async () => {
    post.mockResolvedValue({ data: { on: () => undefined } });
    await service().invokeText(resolved({ generation: { reasoning: { enabled: false } } }), TENANT, { text: 'hi' }, 'stream');

    expect(sentBody().reasoning).toEqual({ enabled: false });
  });
});
