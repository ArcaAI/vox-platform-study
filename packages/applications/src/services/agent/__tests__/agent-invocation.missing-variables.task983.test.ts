/**
 * TASK-983 R9 (lane J) — ONE 400 that names EVERY placeholder the invocation did not supply.
 *
 * Measured on the dev gateway (2026-09-17, tenant-admin API key):
 * `POST /agents/general-medicine-summarization/invocations` with `{ text }` answered 400
 * "instruction references `trigger.context.language`…"; supplying `language` answered 400 for
 * `trigger.context.safe_age`; and so on for nine placeholders. The renderer throws on the FIRST
 * unresolved path, so the contract was discoverable only one call at a time.
 *
 * Pinned here:
 *
 *  1. every missing path is named at once, in `missingVariables`, under
 *     `code: 'PROMPT_VARIABLES_MISSING'`, with the request key each one belongs under;
 *  2. nothing is sent upstream when the body is incomplete;
 *  3. a COMPLETE body proceeds — including one that satisfies the paths through `variables`;
 *  4. the check is SELECTION-AWARE: a conditional fragment this call excludes asks for nothing;
 *  5. the per-path `PromptVariableUnresolved` mapping SURVIVES as the defensive fallback — a
 *     `{ path }` binding is resolved while the scope is built, before this diff can run.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import type { ResolvedAgent } from '@arcaai/types';
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

function resolved(compiledOver: Record<string, unknown>): ResolvedAgent {
  return {
    agentId: 'a1',
    agentVersionId: 'a1',
    slug: 'general-medicine-summarization',
    versionNumber: 3,
    task: 'TEXT_GENERATION',
    tenantId: TENANT,
    source: 'tenant',
    compiledConfig: {
      task: 'TEXT_GENERATION',
      service: 'llm',
      model: { id: 'm1', slug: 'gpt-x', provider: 'openai', taskType: 'TEXT_GENERATION', wireModelId: 'gpt-x-2026-05' },
      fallbacks: [],
      instruction: null,
      resolvedPrompt: null,
      parameters: {},
      inputSchema: { type: 'object' },
      outputSchema: { type: 'string' },
      tools: [],
      ...compiledOver,
    },
    models: [],
  } as unknown as ResolvedAgent;
}

async function refusal(agent: ResolvedAgent, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  try {
    await service().invokeText(agent, TENANT, body, 'blocking');
  } catch (error) {
    expect(error).toBeInstanceOf(BadRequestException);
    return (error as BadRequestException).getResponse() as Record<string, unknown>;
  }
  throw new Error('expected the invocation to be refused');
}

beforeEach(() => {
  vi.clearAllMocks();
  post.mockResolvedValue({ data: { content: 'ok', provider: 'openai', model: 'gpt-x' } });
});

describe('an incomplete invocation is refused ONCE, naming every missing placeholder', () => {
  const threeWay = resolved({
    resolvedPrompt: {
      source: 'inline',
      content: 'Language {{context.language}} for {{input.patient_ref}} in tone {{tone}}; age {{ trigger.safe_age }}.',
    },
  });

  it('names all of them, with the request key each belongs under, and sends nothing', async () => {
    const response = await refusal(threeWay, { text: 'a cough', context: {} });

    expect(response.code).toBe('PROMPT_VARIABLES_MISSING');
    expect(response.missingVariables).toEqual(['context.language', 'input.patient_ref', 'tone', 'trigger.safe_age']);
    expect(response.suppliedUnder).toEqual({
      'context.language': 'context',
      'input.patient_ref': 'input',
      tone: 'variables',
      'trigger.safe_age': 'context',
    });
    expect(String(response.message)).toContain('trigger.safe_age');
    expect(post).not.toHaveBeenCalled();
  });

  it('proceeds once the body supplies all of them', async () => {
    await service().invokeText(
      threeWay,
      TENANT,
      { text: 'a cough', patient_ref: 'p-1', variables: { tone: 'concise' }, context: { language: 'en', safe_age: '48' } },
      'blocking',
    );

    expect(post).toHaveBeenCalledTimes(1);
    expect((post.mock.calls[0]![1] as Record<string, unknown>).system_prompt).toBe('Language en for p-1 in tone concise; age 48.');
  });

  it('asks for nothing a `default("…")` covers', async () => {
    await service().invokeText(
      resolved({ resolvedPrompt: { source: 'inline', content: '{{ trigger.safe_age | default("unknown") }}' } }),
      TENANT,
      { text: 't', context: {} },
      'blocking',
    );

    expect((post.mock.calls[0]![1] as Record<string, unknown>).system_prompt).toBe('unknown');
  });

  it('is SELECTION-AWARE: a fragment this call excludes asks for nothing', async () => {
    const composite = resolved({
      resolvedPrompt: {
        source: 'composite',
        join: '\n\n',
        content: 'base',
        fragments: [
          { key: 'base', source: 'inline', when: null, content: 'Base {{context.language}}' },
          { key: 'revisit', source: 'inline', when: 'context.visit_type == "revisit"', content: '{{context.formatted_previous_visits}}' },
        ],
      },
    });

    await service().invokeText(composite, TENANT, { text: 't', context: { language: 'en', visit_type: 'new' } }, 'blocking');
    expect(post).toHaveBeenCalledTimes(1);

    const response = await refusal(composite, { text: 't', context: { language: 'en', visit_type: 'revisit' } });
    expect(response.missingVariables).toEqual(['context.formatted_previous_visits']);
  });

  it('keeps the per-path refusal as the defensive fallback — a `{ path }` binding fails before the diff runs', async () => {
    const bound = resolved({
      instruction: { variables: { age: { path: 'trigger.safe_age' } } },
      resolvedPrompt: { source: 'inline', content: 'Patient is {{age}}.' },
    });

    const response = await refusal(bound, { text: 't', context: {} });
    expect(String(response.message ?? response)).toContain('trigger.safe_age');
    expect(post).not.toHaveBeenCalled();
  });
});
