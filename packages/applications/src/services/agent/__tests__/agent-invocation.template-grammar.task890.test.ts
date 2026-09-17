/**
 * TASK-890 §3.2/§3.3/§3.4 — `POST /agents/:slug/invocations` renders through the ONE grammar and
 * validates its `context` against the agent's BOUND context schema.
 *
 * Before this ticket `AgentInvocationService` carried the fourth of six templating flavours
 * (§2.4 #4): a flat-key `{{var}}` regex that ACCEPTED a dotted key and then failed to traverse
 * it, so `{{context.patientName}}` was emitted to the model as a literal. There was also no
 * `context` namespace at all — the request body's `context` object was neither validated nor
 * reachable from the prompt.
 *
 * Pinned here:
 *
 * 1. `{{input.*}}` resolves from the validated body and `{{context.*}}` from the request's
 *    `context`, both by DOTTED traversal;
 * 2. a bare `{{name}}` still resolves from `instruction.variables`, and the caller's
 *    `variables` win (§3.3);
 * 3. an undeclared, undefaulted path is a 400 that NAMES the path — never a literal `{{…}}` on
 *    the wire, and never a silently blank prompt;
 * 4. `body.context` is validated against the frozen `compiledConfig.contextSchema.payloadSchema`
 *    (TIER 3) and a violation is a 400 naming the field;
 * 5. a single brace renders VERBATIM — the deleted grammar has no fallback pass.
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
  // TASK-890 §3.14 — every `/api/v1/generate` post from this service states the agent's guardrail
  // decision. Added at the wave-2b close: the merge kept L3's render hunk and L14's guardrail hunk
  // in the same method, and this fixture (L3's) predated the call.
  applyGuardrailDecision: vi.fn((body: Record<string, unknown>, decision: { enabled: boolean } | undefined) => {
    body.guardrail_policy = { enabled: decision?.enabled ?? true };
    return body;
  }),
} as never;

function service(): AgentInvocationService {
  return new AgentInvocationService(httpService, configService, enrichment);
}

function resolved(over: Partial<Record<string, unknown>> = {}): ResolvedAgent {
  const compiled = {
    task: 'TEXT_GENERATION',
    service: 'llm',
    // TASK-890 F9 — a published artifact freezes the ROUTED id beside the reference, and the
    // invocation refuses to post without one, so every fixture here carries it.
    model: { id: 'm1', slug: 'gpt-x', provider: 'openai', taskType: 'TEXT_GENERATION', wireModelId: 'gpt-x-2026-05' },
    fallbacks: [],
    instruction: { systemPrompt: 'x', variables: { ward: '3' } },
    resolvedPrompt: { source: 'inline', content: 'PROMPT' },
    parameters: {},
    inputSchema: { type: 'object' },
    outputSchema: { type: 'string' },
    tools: [],
    ...over,
  };
  return {
    agentId: 'a1',
    agentVersionId: 'a1',
    slug: 'discharge-writer',
    versionNumber: 1,
    task: 'TEXT_GENERATION',
    tenantId: TENANT,
    source: 'tenant',
    compiledConfig: compiled,
    models: [],
  } as unknown as ResolvedAgent;
}

const withPrompt = (content: string, over: Record<string, unknown> = {}): ResolvedAgent =>
  resolved({ resolvedPrompt: { source: 'inline', content }, ...over });

const sentBody = () => post.mock.calls.at(-1)?.[1] as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  post.mockResolvedValue({ data: { content: 'ok', provider: 'openai', model: 'gpt-x' } });
});

describe('AgentInvocationService renders the instruction through the shared grammar', () => {
  it('resolves a dotted `input.*` path from the request body', async () => {
    await service().invokeText(withPrompt('Summarise: {{input.text}} for ward {{ward}}.'), TENANT, { text: 'a cough' }, 'blocking');

    expect(sentBody().system_prompt).toBe('Summarise: a cough for ward 3.');
  });

  it('resolves a dotted `context.*` path from the request context', async () => {
    await service().invokeText(
      withPrompt('Patient {{context.patient.name}}, age {{context.patient.age}}.'),
      TENANT,
      { text: 't', context: { patient: { name: 'Ada', age: 41 } } },
      'blocking',
    );

    expect(sentBody().system_prompt).toBe('Patient Ada, age 41.');
  });

  it('lets the caller’s `variables` win over the agent’s bound ones', async () => {
    await service().invokeText(withPrompt('Ward {{ward}}'), TENANT, { text: 't', variables: { ward: '7' } }, 'blocking');

    expect(sentBody().system_prompt).toBe('Ward 7');
  });

  it('refuses an undeclared, undefaulted path with a 400 that names it — nothing is sent', async () => {
    await expect(service().invokeText(withPrompt('{{context.absent}}'), TENANT, { text: 't', context: {} }, 'blocking')).rejects.toThrow(
      BadRequestException,
    );
    expect(post).not.toHaveBeenCalled();
  });

  it('honours `default("…")` instead of refusing', async () => {
    await service().invokeText(withPrompt('{{context.absent | default("n/a")}}'), TENANT, { text: 't', context: {} }, 'blocking');

    expect(sentBody().system_prompt).toBe('n/a');
  });

  it('leaves a single brace VERBATIM — the deleted grammar has no fallback pass', async () => {
    await service().invokeText(withPrompt('Language: {language_name}'), TENANT, { text: 't' }, 'blocking');

    expect(sentBody().system_prompt).toBe('Language: {language_name}');
  });
});

describe('AgentInvocationService validates `context` against the agent’s bound schema', () => {
  const bound = {
    contextSchema: {
      schemaId: 'schema-1',
      versionNumber: 1,
      payloadSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { patient: { type: 'object', properties: { age: { type: 'number' } } } },
      },
    },
  };

  it('accepts a payload the frozen schema admits', () => {
    expect(service().contextProblems(resolved(bound), { patient: { age: 41 } })).toEqual([]);
  });

  it('reports a violation naming the field', () => {
    const problems = service().contextProblems(resolved(bound), { patient: { age: 'forty-one' } });

    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join(' ')).toContain('age');
  });

  it('reports an undeclared kind (the frozen schema is closed)', () => {
    const problems = service().contextProblems(resolved(bound), { smuggled: true });

    expect(problems.join(' ')).toContain('smuggled');
  });

  it('is a no-op when the agent binds no context schema', () => {
    expect(service().contextProblems(resolved(), { anything: 1 })).toEqual([]);
  });
});

describe('the invocation itself refuses a context the bound schema does not admit', () => {
  const bound = {
    contextSchema: {
      schemaId: 'schema-1',
      versionNumber: 1,
      payloadSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { patient: { type: 'object', properties: { age: { type: 'number' } } } },
      },
    },
  };

  it('throws a 400 naming the violation and sends nothing upstream', async () => {
    await expect(
      service().invokeText(withPrompt('PROMPT', bound), TENANT, { text: 't', context: { patient: { age: 'forty-one' } } }, 'blocking'),
    ).rejects.toThrow(BadRequestException);
    expect(post).not.toHaveBeenCalled();
  });

  it('proceeds when the context is admitted', async () => {
    await service().invokeText(
      withPrompt('Age {{context.patient.age}}', bound),
      TENANT,
      { text: 't', context: { patient: { age: 41 } } },
      'blocking',
    );

    expect(sentBody().system_prompt).toBe('Age 41');
  });
});

/**
 * J3-5 — one kind keyed `context` is not an envelope, and the agent path unwraps it.
 *
 * The bridge schema `consultation_legacy_v1` declares exactly one kind whose key is `context`,
 * so `payloadSchemaFromDefinition` produced `{ context: { safe_age, … } }` while every seeded
 * template reads `{{context.safe_age}}` and the render scope aliases `context` to the whole
 * envelope. The reference resolved to nothing; the only spelling that could have worked was
 * `{{context.context.safe_age}}`. The seed ships that exact pairing, so the seeded combination
 * could not run on an agent at all.
 *
 * Narrow by decision: only when there is ONE kind and its key IS the namespace root. A
 * multi-kind envelope is unchanged — there the key is the only thing saying which kind a value
 * belongs to.
 */
describe('the single-kind `context` envelope (J3-5)', () => {
  const legacyBound = {
    contextSchema: {
      schemaId: 'schema-legacy',
      versionNumber: 1,
      payloadSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          context: { type: 'object', properties: { safe_age: { type: 'string' }, visit_type: { type: 'string' } } },
        },
      },
    },
  };

  const multiBound = {
    contextSchema: {
      schemaId: 'schema-multi',
      versionNumber: 1,
      payloadSchema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          context: { type: 'object', properties: { safe_age: { type: 'string' } } },
          audio: { type: 'object' },
        },
      },
    },
  };

  it('accepts a FLAT context payload against the sole kind`s own schema', () => {
    expect(service().contextProblems(resolved(legacyBound), { safe_age: '41', visit_type: 'follow-up' })).toEqual([]);
  });

  it('still reports a violation inside that kind — unwrapping is not a bypass', () => {
    const problems = service().contextProblems(resolved(legacyBound), { safe_age: 41 });
    expect(problems.join(' ')).toContain('safe_age');
  });

  it('renders `{{context.safe_age}}` from the flat payload — the seeded template, running', async () => {
    await service().invokeText(
      withPrompt('Patient age {{context.safe_age}}.', legacyBound),
      TENANT,
      { text: 't', context: { safe_age: '41' } },
      'blocking',
    );

    expect(sentBody().system_prompt).toBe('Patient age 41.');
  });

  it('also renders from the ENVELOPE form, so one prompt is portable from a workflow trigger', async () => {
    await service().invokeText(
      withPrompt('Patient age {{context.safe_age}}.', legacyBound),
      TENANT,
      { text: 't', context: { context: { safe_age: '41' } } },
      'blocking',
    );

    expect(sentBody().system_prompt).toBe('Patient age 41.');
  });

  it('leaves a MULTI-kind envelope verbatim — a flat payload there is still a violation', () => {
    const problems = service().contextProblems(resolved(multiBound), { safe_age: '41' });
    expect(problems.length).toBeGreaterThan(0);
  });
});
