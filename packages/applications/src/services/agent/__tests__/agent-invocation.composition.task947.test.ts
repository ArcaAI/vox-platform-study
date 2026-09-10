/**
 * TASK-947 §4.1 — `POST /agents/:slug/invocations` COMPOSES the system prompt.
 *
 * The renderer is `composePrompt`, over the SAME scope `buildAgentPromptScope` already builds:
 *
 *  1. a fragment with no `when` is always in; a `when` that holds selects; one that does not
 *     EXCLUDES — and one that cannot evaluate excludes too (OD-5), because a missing branch
 *     input is "this encounter has no opinion", not a broken prompt;
 *  2. each fragment is rendered ON ITS OWN and the parts are joined, so a substituted value is
 *     never re-interpreted and a `{{` cannot pair with a `}}` across a fragment boundary;
 *  3. the response names the SELECTED KEYS and nothing else (OD-11) — never a body, never a
 *     condition string, both of which can carry PHI;
 *  4. an empty composition is a named 400, not a call to TEXT with no system prompt;
 *  5. the two pre-947 shapes still render exactly as they did, and carry `promptFragments: null`.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, Logger } from '@nestjs/common';
import type { AgentCompiledPromptFragment, ResolvedAgent } from '@arcaai/types';
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

function composite(fragments: AgentCompiledPromptFragment[], instruction: Record<string, unknown> = {}): ResolvedAgent {
  const unconditional = fragments.filter((fragment) => fragment.when === null).map((fragment) => fragment.content);
  return {
    agentId: 'a1',
    agentVersionId: 'a1',
    slug: 'discharge-writer',
    versionNumber: 1,
    task: 'TEXT_GENERATION',
    tenantId: TENANT,
    source: 'tenant',
    compiledConfig: {
      task: 'TEXT_GENERATION',
      service: 'llm',
      model: { id: 'm1', slug: 'gpt-x', provider: 'openai', taskType: 'TEXT_GENERATION', wireModelId: 'gpt-x-2026-05' },
      fallbacks: [],
      instruction: { fragments: [], ...instruction },
      resolvedPrompt: { source: 'composite', join: '\n\n', content: unconditional.join('\n\n'), fragments },
      parameters: {},
      inputSchema: { type: 'object' },
      outputSchema: { type: 'string' },
      tools: [],
      protocols: ['http'],
    },
    models: [],
  } as unknown as ResolvedAgent;
}

const inline = (key: string, content: string, when: string | null = null): AgentCompiledPromptFragment => ({
  key,
  source: 'inline',
  content,
  when,
});

const sentBody = () => post.mock.calls.at(-1)?.[1] as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  post.mockResolvedValue({ data: { content: 'ok', provider: 'openai', model: 'gpt-x' } });
});

describe('selection over the render scope (§4.1, OD-5)', () => {
  it('includes an unconditional fragment and one whose `when` holds, in authored order', async () => {
    const result = await service().invokeText(
      composite([inline('base', 'BASE'), inline('revisit', 'REVISIT', "context.visit_type == 'revisit'")]),
      TENANT,
      { text: 't', context: { visit_type: 'revisit' } },
      'blocking',
    );

    expect(sentBody().system_prompt).toBe('BASE\n\nREVISIT');
    expect(result.promptFragments).toEqual({ selected: ['base', 'revisit'] });
  });

  it('EXCLUDES a fragment whose `when` is false', async () => {
    const result = await service().invokeText(
      composite([inline('base', 'BASE'), inline('revisit', 'REVISIT', "context.visit_type == 'revisit'")]),
      TENANT,
      { text: 't', context: { visit_type: 'new' } },
      'blocking',
    );

    expect(sentBody().system_prompt).toBe('BASE');
    expect(result.promptFragments).toEqual({ selected: ['base'] });
  });

  it('EXCLUDES a fragment whose `when` cannot evaluate — never fatal (OD-5)', async () => {
    const result = await service().invokeText(
      composite([inline('base', 'BASE'), inline('peds', 'PEDS', 'context.patient_age < 18')]),
      TENANT,
      { text: 't', context: {} },
      'blocking',
    );

    expect(sentBody().system_prompt).toBe('BASE');
    expect(result.promptFragments).toEqual({ selected: ['base'] });
  });

  it('selects on a `has()` guard, which is the shape authors are told to write', async () => {
    const result = await service().invokeText(
      composite([inline('base', 'BASE'), inline('peds', 'PEDS', 'has(context.patient_age) && context.patient_age < 18')]),
      TENANT,
      { text: 't', context: { patient_age: 9 } },
      'blocking',
    );
    expect(result.promptFragments).toEqual({ selected: ['base', 'peds'] });
  });

  it('sees `input.*` and the bare bound names, exactly as the template does', async () => {
    const agent = composite([inline('base', 'BASE'), inline('ward3', 'WARD3', "ward == '3' && input.mode == 'full'")], {
      variables: { ward: { path: 'context.ward' } },
    });
    agent.compiledConfig.instruction = { fragments: [], variables: { ward: { path: 'context.ward' } } };

    const result = await service().invokeText(agent, TENANT, { text: 't', mode: 'full', context: { ward: '3' } }, 'blocking');
    expect(result.promptFragments).toEqual({ selected: ['base', 'ward3'] });
  });
});

describe('rendering (§4.1 — one pass PER fragment)', () => {
  it('renders each fragment against the scope and joins with `\\n\\n`', async () => {
    await service().invokeText(
      composite([inline('base', 'Ward {{context.ward}}'), inline('note', 'Note: {{input.text}}')]),
      TENANT,
      { text: 'a cough', context: { ward: 'B' } },
      'blocking',
    );
    expect(sentBody().system_prompt).toBe('Ward B\n\nNote: a cough');
  });

  it('never lets a `{{` pair with a `}}` across a fragment boundary', async () => {
    // Rendered as ONE body these two halves would form the placeholder `{{context.ward}}`.
    // Rendered per fragment the opener is an unterminated placeholder in ITS OWN body, which the
    // grammar refuses — so the pairing is impossible rather than merely unlikely.
    await expect(
      service().invokeText(
        composite([inline('opener', 'A {{context.'), inline('closer', 'ward}} B')]),
        TENANT,
        { text: 't', context: { ward: 'B' } },
        'blocking',
      ),
    ).rejects.toMatchObject({ response: { code: 'PROMPT_TEMPLATE_SYNTAX' } });
    expect(post).not.toHaveBeenCalled();
  });

  it('never re-interprets a SUBSTITUTED value as a placeholder (the one-pass rule survives the join)', async () => {
    await service().invokeText(
      composite([inline('base', 'Ward {{context.ward}}'), inline('tail', 'end')]),
      TENANT,
      { text: 't', context: { ward: '{{context.secret}}', secret: 'leaked' } },
      'blocking',
    );
    expect(sentBody().system_prompt).toBe('Ward {{context.secret}}\n\nend');
  });

  it('still refuses an unresolved variable INSIDE a fragment with a 400 naming the path', async () => {
    await expect(
      service().invokeText(composite([inline('base', '{{context.absent}}')]), TENANT, { text: 't', context: {} }, 'blocking'),
    ).rejects.toThrow(BadRequestException);
    expect(post).not.toHaveBeenCalled();
  });
});

describe('an empty composition is a named refusal (OD-6)', () => {
  it('answers 400 `PROMPT_COMPOSITION_EMPTY` and names the excluded keys — nothing is sent', async () => {
    const agent = composite([inline('revisit', 'R', "context.visit_type == 'revisit'"), inline('peds', 'P', 'context.patient_age < 18')]);
    await expect(service().invokeText(agent, TENANT, { text: 't', context: { visit_type: 'new' } }, 'blocking')).rejects.toMatchObject({
      response: { code: 'PROMPT_COMPOSITION_EMPTY', excluded: [{ key: 'revisit', reason: 'condition_false' }, { key: 'peds' }] },
    });
    expect(post).not.toHaveBeenCalled();
  });
});

describe('the two pre-947 shapes are untouched', () => {
  it('an inline resolved prompt renders as before and carries `promptFragments: null`', async () => {
    const agent = composite([]);
    agent.compiledConfig.resolvedPrompt = { source: 'inline', content: 'Ward {{context.ward}}' };
    const result = await service().invokeText(agent, TENANT, { text: 't', context: { ward: 'B' } }, 'blocking');

    expect(sentBody().system_prompt).toBe('Ward B');
    expect(result.promptFragments).toBeNull();
  });

  it('an agent with NO resolved prompt sends no `system_prompt` at all', async () => {
    const agent = composite([]);
    agent.compiledConfig.resolvedPrompt = null;
    const result = await service().invokeText(agent, TENANT, { text: 't' }, 'blocking');

    expect(sentBody()).not.toHaveProperty('system_prompt');
    expect(result.promptFragments).toBeNull();
  });
});

/**
 * TASK-947 R2 M-1 — an exclusion on the invocation lane left NO server-side record, so a safety
 * fragment dropped by a wrong-typed caller input was unreconstructible. The live and durable lanes
 * already logged; this lane now does too — a `condition_error` at WARN (always an authoring or
 * contract defect), a `condition_false` at DEBUG (ordinary traffic) — keys and reasons only.
 */
describe('R2 M-1 — exclusions are recorded, keys and reasons only', () => {
  it('warns on a condition_error naming the agent and the key, never the detail', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const debug = vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    await service().invokeText(
      composite([inline('base', 'BASE'), inline('peds_safety', 'MINOR', 'context.patient_age < 18')]),
      TENANT,
      { text: 't', context: { patient_age: 'seven' } },
      'blocking',
    );
    expect(warn).toHaveBeenCalledTimes(1);
    const entry = warn.mock.calls[0]?.[0] as Record<string, unknown>;
    expect(entry).toMatchObject({ agentSlug: 'discharge-writer', excluded: [{ key: 'peds_safety', reason: 'condition_error' }] });
    expect(JSON.stringify(entry)).not.toContain('no such overload');
    expect(JSON.stringify(entry)).not.toContain('seven');
    expect(debug).not.toHaveBeenCalled();
    warn.mockRestore();
    debug.mockRestore();
  });

  it('a condition_false is debug-level; a single-body agent logs nothing', async () => {
    const warn = vi.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    const debug = vi.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    await service().invokeText(
      composite([inline('base', 'BASE'), inline('revisit', 'REVISIT', "context.visit_type == 'revisit'")]),
      TENANT,
      { text: 't', context: { visit_type: 'new' } },
      'blocking',
    );
    expect(warn).not.toHaveBeenCalled();
    expect(debug).toHaveBeenCalledTimes(1);
    expect(debug.mock.calls[0]?.[0]).toMatchObject({ excluded: [{ key: 'revisit', reason: 'condition_false' }] });
    warn.mockRestore();
    debug.mockRestore();
  });
});
