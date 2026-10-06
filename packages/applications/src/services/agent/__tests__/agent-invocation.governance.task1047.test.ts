/**
 * TASK-1047 D1 / FC-4 on the agent invocation lane.
 *
 *   - a caller's `variables` and `context.*` reach the instruction as POINTERS (FC-1) — their values
 *     are data blocks in the user message, never system text;
 *   - the composer's governance of the system it composed rides the egress hint (`systemGovernance`),
 *     with the platform pieces it emitted and the invocation's tenant, so the ONE enrichment decides
 *     whether `system_governance` is sent.
 */
import { createHash } from 'node:crypto';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedAgent } from '@arcaai/types';
import { platformRules } from '@arcaai/workflow-contract';
import { AgentInvocationService } from '../agent-invocation.service';

const TENANT = '50000000-0000-0000-0000-000000000001';
const post = vi.fn();
const enrichment = {
  applyTextRuntimeProfile: vi.fn().mockResolvedValue(undefined),
  applyTenantProviderOverrides: vi.fn().mockResolvedValue(undefined),
};
const service = () =>
  new AgentInvocationService({ axiosRef: { post } } as never, { get: vi.fn().mockReturnValue('http://text.test') } as never, enrichment as never);

function agent(content: string): ResolvedAgent {
  return {
    agentId: 'a1',
    agentVersionId: 'av1',
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
      instruction: { systemPrompt: content },
      resolvedPrompt: { source: 'inline', content },
      parameters: {},
      inputSchema: { type: 'object' },
      outputSchema: { type: 'object' },
      tools: [],
    },
    models: [],
  } as unknown as ResolvedAgent;
}

const sent = () => post.mock.calls.at(-1)?.[1] as Record<string, unknown>;
const hints = () => enrichment.applyTenantProviderOverrides.mock.calls.at(-1)?.[1] as Record<string, unknown>;

beforeEach(() => {
  vi.clearAllMocks();
  post.mockResolvedValue({ data: { content: 'ok' } });
});

describe('caller values never become system text', () => {
  it('renders a caller variable and a context value as pointers, their values as data blocks', async () => {
    await service().invokeText(agent('Complaint: {{complaint}}. Vitals: {{context.formatted_vitals}}.'), TENANT, {
      message: 'hello',
      variables: { complaint: 'CHEST-PAIN-MARKER' },
      context: { formatted_vitals: 'BP 155/95 VITALS-MARKER' },
    }, 'blocking');

    const body = sent();
    expect(body.system_prompt).toBe(`${platformRules()}\n\nComplaint: [see the complaint data section below]. Vitals: [see the context_formatted_vitals data section below].`);
    expect(body.prompt).toContain('CHEST-PAIN-MARKER');
    expect(body.prompt).toContain('VITALS-MARKER');
  });
});

describe('FC-4 — the composed governance rides the egress hint', () => {
  it('hands the enrichment the governance of exactly the system it sends, the platform pieces and the tenant', async () => {
    await service().invokeText(agent('Write a note.'), TENANT, { message: 'hello' }, 'blocking');

    const body = sent();
    const hint = hints().systemGovernance as {
      governance: { composedDigest: string; pieces: { kind: string; key: string }[] };
      platformPieces: { kind: string; sourceKey: string; text: string }[];
      tenantId: string;
    };
    expect(hint.governance.composedDigest).toBe(createHash('sha256').update(String(body.system_prompt), 'utf8').digest('hex'));
    expect(hint.governance.pieces.map((piece) => piece.kind)).toEqual(['PLATFORM', 'TEMPLATE_BODY']);
    expect(hint.platformPieces).toEqual([{ kind: 'PLATFORM', sourceType: 'PLATFORM', sourceId: null, sourceKey: expect.stringMatching(/^platform-rules@/), text: platformRules() }]);
    expect(hint.tenantId).toBe(TENANT);
  });
});
