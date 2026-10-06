/**
 * TASK-1036 OD-10 (lane B6b) — on the invocation lane an OPTIONAL declared variable the call does
 * not supply renders `""` (it used to refuse the call with PROMPT_VARIABLES_MISSING), a REQUIRED one
 * still fails by name, and a whitespace-only data block is dropped rather than sent as an empty
 * delimited section. The declarations ride on the frozen `resolvedPrompt` (`variables`).
 */
import { BadRequestException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedAgent } from '@arcaai/types';
import { AGENT_IO_DEFAULTS } from '@arcaai/workflow-contract';
import { AgentInvocationService } from '../agent-invocation.service';
import { withPlatformRules, readByModel } from './compose-expectations';

// TASK-1047 FC-1 — placeholders are POINTERS in the system message and their values data blocks; the
// rendering assertions below read the system as the model does (`readByModel`).


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

function agent(variables: Array<Record<string, unknown>>): ResolvedAgent {
  const content = 'Tone: {{tone}}.';
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
      instruction: { promptTemplateId: 'tpl-1', promptVersionNumber: 2 },
      resolvedPrompt: { source: 'template', promptTemplateId: 'tpl-1', promptVersionNumber: 2, content, variables },
      parameters: {},
      inputSchema: AGENT_IO_DEFAULTS.TEXT_GENERATION.inputSchema,
      outputSchema: { type: 'object' },
      tools: [],
    },
    models: [],
  } as unknown as ResolvedAgent;
}

const sent = () => post.mock.calls.at(-1)?.[1] as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  post.mockResolvedValue({ data: { content: 'ok', provider: 'openai', model: 'gpt-x' } });
});

describe('OD-10 on the invocation lane', () => {
  it('an absent OPTIONAL variable renders "" and a whitespace-only message block is dropped', async () => {
    await service().invokeText(agent([{ name: 'tone', type: 'string', required: false }]), TENANT, { message: '  \n ' }, 'blocking');
    expect(readByModel(sent())).toBe(withPlatformRules('Tone: .'));
    // TASK-1047 FC-1 — the placeholder's (empty) value is its own block so the pointer never
    // dangles; the whitespace-only MESSAGE block is still dropped.
    expect(sent().prompt).toBe('<<<EXTERNAL_DATA section="tone">>>\n--- tone ---\n\n<<<END_EXTERNAL_DATA>>>');
  });

  it('an absent REQUIRED variable still refuses the call by name', async () => {
    const error = await service()
      .invokeText(agent([{ name: 'tone', type: 'string', required: true }]), TENANT, { message: 'hi' }, 'blocking')
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BadRequestException);
    expect((error as BadRequestException).getResponse()).toMatchObject({ code: 'PROMPT_VARIABLES_MISSING', missingVariables: ['tone'] });
  });
});
