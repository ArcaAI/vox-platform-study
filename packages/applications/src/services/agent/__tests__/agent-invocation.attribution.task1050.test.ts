/**
 * TASK-1050 finding D — an agent invocation made on a consultation's behalf (fact ledger, chain
 * summary) carries the guardrail ATTRIBUTION its caller knows: the consultation (egress hint +
 * `X-Hope-Consultation-Id`), the context items behind the `input` region, and a run key. Without
 * it the evaluation had no `consultationId` and no item a warn/block could mark.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedAgent } from '@arcaai/types';
import { AgentInvocationService } from '../agent-invocation.service';

const TENANT = '50000000-0000-0000-0000-000000000001';
const post = vi.fn();
const httpService = { axiosRef: { post } } as never;
const configService = { get: vi.fn(() => 'http://text.test') } as never;
const enrichment = {
  applyTextRuntimeProfile: vi.fn().mockResolvedValue(undefined),
  applyTenantProviderOverrides: vi.fn().mockResolvedValue(undefined),
};

const service = () => new AgentInvocationService(httpService, configService, enrichment as never);

const textAgent = {
  agentId: 'a2',
  agentVersionId: 'a2',
  slug: 'fact-ledger-extraction',
  versionNumber: 1,
  task: 'TEXT_GENERATION',
  tenantId: TENANT,
  source: 'tenant',
  compiledConfig: {
    task: 'TEXT_GENERATION',
    service: 'llm',
    model: { id: 'm2', slug: 'lms-gemma', provider: 'lm-studio', taskType: 'TEXT_GENERATION', wireModelId: 'gemma-4' },
    fallbacks: [],
    instruction: null,
    resolvedPrompt: null,
    parameters: {},
    inputSchema: { type: 'object' },
    outputSchema: { type: 'string' },
    tools: [],
  },
  models: [],
  guardrail: { enabled: true },
} as unknown as ResolvedAgent;

beforeEach(() => {
  vi.clearAllMocks();
  post.mockResolvedValue({ data: { content: 'ok' } });
});

describe('invokeText — caller-known guardrail attribution', () => {
  it('states consultation, region items and run key on the hints and the X-Hope-* headers', async () => {
    await service().invokeText(textAgent, TENANT, { message: 'hi' }, 'blocking', {
      attribution: {
        consultationId: 'c-1',
        regionItems: { input: [{ itemId: 'seg-1', itemVersion: 2 }] },
        correlation: { runKey: 'fact-ledger:c-1:e1-abc:0' },
      },
    });
    expect(enrichment.applyTenantProviderOverrides.mock.calls.at(-1)?.[1]).toMatchObject({
      agentSlug: 'fact-ledger-extraction',
      consultationId: 'c-1',
      regionItems: { input: [{ itemId: 'seg-1', itemVersion: 2 }] },
      correlation: { runKey: 'fact-ledger:c-1:e1-abc:0' },
    });
    const headers = (post.mock.calls.at(-1)?.[2] as { headers: Record<string, string> }).headers;
    expect(headers['X-Hope-Consultation-Id']).toBe('c-1');
    expect(headers['X-Hope-Run-Key']).toBe('fact-ledger:c-1:e1-abc:0');
  });

  it('without attribution, no consultation is invented', async () => {
    await service().invokeText(textAgent, TENANT, { message: 'hi' }, 'blocking');
    expect((enrichment.applyTenantProviderOverrides.mock.calls.at(-1)?.[1] as { consultationId?: unknown }).consultationId ?? null).toBeNull();
    const headers = (post.mock.calls.at(-1)?.[2] as { headers: Record<string, string> }).headers;
    expect(Object.keys(headers).some((name) => name.toLowerCase().startsWith('x-hope-'))).toBe(false);
  });
});

describe('invokeText — the generation`s guardrail notices reach the caller', () => {
  it('returns the notices TEXT answered with (`guardrail_notices`)', async () => {
    const warning = {
      schemaVersion: 1,
      noticeId: 'n-1',
      type: 'guardrail.warning',
      direction: 'outbound',
      action: 'warn',
      checks: [],
      itemIds: [],
      messageKey: 'guardrail.warning.generic',
      defaultMessage: 'x',
      requiresAcknowledgement: true,
      resumable: false,
      policyVersion: 'pv-1',
      occurredAt: '2026-10-08T00:00:00.000Z',
    };
    post.mockResolvedValue({ data: { content: 'ok', guardrail_notices: [warning] } });
    const result = await service().invokeText(textAgent, TENANT, { message: 'hi' }, 'blocking');
    expect(result.guardrailNotices).toEqual([warning]);
  });

  it('none answered, none returned', async () => {
    const result = await service().invokeText(textAgent, TENANT, { message: 'hi' }, 'blocking');
    expect(result.guardrailNotices).toEqual([]);
  });
});
