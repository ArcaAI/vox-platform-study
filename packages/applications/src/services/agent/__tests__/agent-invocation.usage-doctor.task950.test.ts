/**
 * TASK-950 (decision 3, fast win) — `invokeText` HANDS BACK the acting clinician it resolved.
 *
 * Lane E made this plane resolve (and provision) the schema-declared identity for a machine
 * caller, then log it and drop it. That left the invocation plane with no durable attribution at
 * all: `AgentInvocationService` writes no row and broadcasts no sys-event, so the only per-call
 * record it produces is the usage ledger the GATEWAY emits — and that row's `doctorId` was always
 * null. It cannot be filled unless this method says who the acting user was.
 *
 * ## Why the value is returned internally rather than put on the response DTO
 *
 * The caller supplied the staff identifier; echoing the HOPE user it maps to would turn every
 * invocation into a directory lookup for anyone holding a credential. So the public
 * `AgentTextInvocationResponse` is deliberately unchanged — this is an internal hand-off from the
 * service to the one consumer that needs it, asserted here as "present on the result object".
 *
 * ## Both modes, one resolution
 *
 * `blocking` and `stream` reach the model through this one method and share the single
 * `resolveContextUserIdentity` call. The stream return is built AFTER the model call, so the value
 * has to be carried forward rather than re-resolved — re-resolving could provision a second time.
 * Both returns are pinned here for that reason.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResolvedAgent } from '@arcaai/types';
import { AgentInvocationService } from '../agent-invocation.service';

const TENANT = '50000000-0000-0000-0000-000000000001';
const SERVICE_ACCOUNT_ID = 'svc-account-1';
const PROVISIONED_USER = '70000000-0000-0000-0000-0000000009e5';

const post = vi.fn();
const httpService = { axiosRef: { post } } as never;
const configService = { get: vi.fn().mockReturnValue('http://text.test') } as never;
const enrichment = {
  applyTextRuntimeProfile: vi.fn().mockResolvedValue(undefined),
  applyTenantProviderOverrides: vi.fn().mockResolvedValue(undefined),
  applyGuardrailDecision: vi.fn((body: Record<string, unknown>) => body),
} as never;

const resolveOrProvision = vi.fn();
const userIdentity = { resolveOrProvision } as never;

/** CLS as the guard leaves it: a machine principal lives on `serviceAccount`, NEVER on `user`. */
const clsFor = (principal: 'machine' | 'human') =>
  ({
    get: vi.fn((key: string) => {
      if (key === 'serviceAccount') return principal === 'machine' ? { id: SERVICE_ACCOUNT_ID } : null;
      if (key === 'user') return principal === 'human' ? { id: 'user-7' } : null;
      return undefined;
    }),
  }) as never;

function service(principal: 'machine' | 'human' = 'machine'): AgentInvocationService {
  return new AgentInvocationService(httpService, configService, enrichment, undefined, undefined, clsFor(principal), userIdentity);
}

/** A published TEXT_GENERATION agent with the given `contextSchema` FROZEN onto its compiled config. */
function agent(contextSchema: Record<string, unknown> | null): ResolvedAgent {
  return {
    agentId: 'a1',
    agentVersionId: 'a1v1',
    slug: 'clinic-summarizer',
    versionNumber: 1,
    task: 'TEXT_GENERATION',
    tenantId: TENANT,
    source: 'tenant',
    compiledConfig: {
      task: 'TEXT_GENERATION',
      service: 'llm',
      model: { id: 'm1', slug: 'gpt-x', provider: 'openai', taskType: 'TEXT_GENERATION', wireModelId: 'gpt-x-2026-05' },
      fallbacks: [],
      instruction: null,
      resolvedPrompt: { source: 'inline', content: 'PROMPT' },
      parameters: {},
      inputSchema: { type: 'object' },
      outputSchema: { type: 'string' },
      tools: [],
      protocols: ['http'],
      ...(contextSchema ? { contextSchema } : {}),
    },
    models: [],
    guardrail: { enabled: true },
  } as unknown as ResolvedAgent;
}

const SOLE_KIND_SCHEMA = {
  type: 'object',
  properties: {
    context: { type: 'object', properties: { consultant_id: { type: 'string' } }, additionalProperties: true },
  },
  additionalProperties: false,
};

const frozen = (payloadSchema: Record<string, unknown>, userIdentityMarker?: unknown): Record<string, unknown> => ({
  schemaId: 'schema-1',
  versionNumber: 3,
  versionId: 'schema-1-v3',
  payloadSchema,
  ...(userIdentityMarker === undefined ? {} : { userIdentity: userIdentityMarker }),
});

const IDENTITY_AGENT = () => agent(frozen(SOLE_KIND_SCHEMA, { kindKey: 'context', field: 'consultant_id' }));
const INPUT = { text: 'summarise', context: { context: { consultant_id: 'DR-4471' } } };

beforeEach(() => {
  vi.clearAllMocks();
  post.mockResolvedValue({ data: { content: 'ok', provider: 'openai', model: 'gpt-x', usage: { prompt_tokens: 12, completion_tokens: 4 } } });
  resolveOrProvision.mockResolvedValue({ userId: PROVISIONED_USER, provisioned: true });
});

describe('TASK-950 — invokeText returns the resolved acting user', () => {
  it('blocking: carries `actingUserId` on the result when one was resolved', async () => {
    const result = await service('machine').invokeText(IDENTITY_AGENT(), TENANT, INPUT, 'blocking');

    expect(result.actingUserId).toBe(PROVISIONED_USER);
  });

  it('blocking: leaves the rest of the result untouched — this is an addition, not a reshape', async () => {
    const result = await service('machine').invokeText(IDENTITY_AGENT(), TENANT, INPUT, 'blocking');

    expect(result).toMatchObject({
      text: 'ok',
      provider: 'openai',
      model: 'gpt-x',
      usage: { promptTokens: 12, completionTokens: 4 },
      promptFragments: null,
    });
  });

  it('stream: carries `actingUserId` alongside the stream, resolved BEFORE the model call', async () => {
    const chunks = { on: vi.fn(), destroy: vi.fn() };
    post.mockResolvedValue({ data: chunks });

    const result = await service('machine').invokeText(IDENTITY_AGENT(), TENANT, INPUT, 'stream');

    expect(result.stream).toBe(chunks);
    expect(result.actingUserId).toBe(PROVISIONED_USER);
  });

  it('omits it for a HUMAN caller — nothing was resolved, so there is nothing to report (D-5)', async () => {
    const result = await service('human').invokeText(IDENTITY_AGENT(), TENANT, INPUT, 'blocking');

    expect(resolveOrProvision).not.toHaveBeenCalled();
    expect(result.actingUserId).toBeUndefined();
  });

  it('omits it when the agent’s frozen schema declares no identity field', async () => {
    const result = await service('machine').invokeText(agent(frozen(SOLE_KIND_SCHEMA)), TENANT, INPUT, 'blocking');

    expect(resolveOrProvision).not.toHaveBeenCalled();
    expect(result.actingUserId).toBeUndefined();
  });

  it('omits it when the marker is declared but the request sends no value', async () => {
    const result = await service('machine').invokeText(IDENTITY_AGENT(), TENANT, { text: 'summarise', context: { context: {} } }, 'blocking');

    expect(resolveOrProvision).not.toHaveBeenCalled();
    expect(result.actingUserId).toBeUndefined();
  });

  it('resolves ONCE per call — the stream return reuses the value, it does not provision again', async () => {
    const chunks = { on: vi.fn(), destroy: vi.fn() };
    post.mockResolvedValue({ data: chunks });

    await service('machine').invokeText(IDENTITY_AGENT(), TENANT, INPUT, 'stream');

    expect(resolveOrProvision).toHaveBeenCalledTimes(1);
  });
});
