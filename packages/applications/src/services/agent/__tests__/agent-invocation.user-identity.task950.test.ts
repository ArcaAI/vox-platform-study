/**
 * TASK-950 §C5 — an agent invocation resolves the schema-declared USER IDENTITY, for a machine
 * caller and for nobody else.
 *
 * The ticket's claim on this plane (D-3/D-5/D-6, TDD test 28) is narrow and worth stating as
 * behaviour rather than as mechanics: when a SERVICE ACCOUNT invokes an agent whose FROZEN
 * context schema names an identity field, and the request supplies a value for it, the gateway
 * turns that tenant staff identifier into a HOPE user before the model runs. In every other
 * combination — a human caller, a schema with no marker, a marker with no value, a value that is
 * not a string — nothing is resolved and nothing is provisioned.
 *
 * What is pinned here, and why each one is a rule someone could plausibly get wrong:
 *
 *  1. a machine + a frozen marker + a supplied value → `resolveOrProvision` is called with the
 *     EXACT input the resolver's contract names (tenant, trimmed-by-the-resolver staff id,
 *     `departmentId: null`, and a provenance naming the plane, the field and the ACTOR);
 *  2. a HUMAN caller resolves nothing (D-5) — the caller already IS the clinician, so mapping a
 *     different one would be an impersonation;
 *  3. an agent whose schema declares no marker resolves nothing — absence is "no identity field",
 *     never "invalid";
 *  4. a declared marker with no value, or a non-string value, resolves nothing (D-2: presence is
 *     governed by the schema's own `required` flags, never by the marker);
 *  5. BOTH context shapes the agent plane accepts (J3-5) reach the same value — the envelope
 *     `{ context: { … } }` and, under the sole-kind rule, the flat `{ … }`. Reading only one of
 *     them would give the same request two different acting users;
 *  6. resolution happens AFTER the context gate and BEFORE the model call: a schema violation
 *     provisions nobody, and a resolver refusal spends nothing;
 *  7. the resolver's refusals propagate VERBATIM — this lane adds no translation layer.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
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

function service(principal: 'machine' | 'human' = 'machine', identity: unknown = userIdentity): AgentInvocationService {
  return new AgentInvocationService(httpService, configService, enrichment, undefined, undefined, clsFor(principal), identity as never);
}

/**
 * A published TEXT_GENERATION agent, with whatever `contextSchema` the case needs FROZEN onto its
 * compiled config — which is the only place this lane ever reads it from (invariant 4).
 */
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
      ...(contextSchema ? { contextSchema } : {}),
    },
    models: [],
    guardrail: { enabled: true },
  } as unknown as ResolvedAgent;
}

/** One STRUCTURED kind keyed `context` — the sole-kind shape J3-5 lets a caller send FLAT. */
const SOLE_KIND_SCHEMA = {
  type: 'object',
  properties: {
    context: { type: 'object', properties: { consultant_id: { type: 'string' } }, additionalProperties: true },
  },
  additionalProperties: false,
};

/** A kind under a DIFFERENT key — no unwrap applies, so only the envelope shape is valid. */
const NAMED_KIND_SCHEMA = {
  type: 'object',
  properties: {
    intake: { type: 'object', properties: { staff_no: { type: 'string' } }, additionalProperties: true },
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

beforeEach(() => {
  vi.clearAllMocks();
  post.mockResolvedValue({ data: { content: 'ok', provider: 'openai', model: 'gpt-x' } });
  resolveOrProvision.mockResolvedValue({ userId: PROVISIONED_USER, provisioned: true });
});

describe('a MACHINE caller resolves the declared identity field', () => {
  it('calls the resolver with the pinned input, naming the plane, the field and the actor', async () => {
    await service('machine').invokeText(
      agent(frozen(SOLE_KIND_SCHEMA, { kindKey: 'context', field: 'consultant_id' })),
      TENANT,
      { text: 'summarise', context: { context: { consultant_id: 'DR-4471' } } },
      'blocking',
    );

    expect(resolveOrProvision).toHaveBeenCalledTimes(1);
    expect(resolveOrProvision).toHaveBeenCalledWith({
      tenantId: TENANT,
      staffId: 'DR-4471',
      // OD-8 — an invocation names no department; `null` is "this plane has none", which is what
      // makes the resolver fall to the tenant setting and then fail closed.
      departmentId: null,
      provenance: {
        plane: 'agent-invocation',
        kindKey: 'context',
        field: 'consultant_id',
        serviceAccountId: SERVICE_ACCOUNT_ID,
        schemaId: 'schema-1',
        versionNumber: 3,
      },
    });
  });

  it('reads the value from the ENVELOPE shape when the schema keys several kinds', async () => {
    await service('machine').invokeText(
      agent(frozen(NAMED_KIND_SCHEMA, { kindKey: 'intake', field: 'staff_no' })),
      TENANT,
      { text: 'summarise', context: { intake: { staff_no: 'EMP-9' } } },
      'blocking',
    );

    expect(resolveOrProvision).toHaveBeenCalledWith(expect.objectContaining({ staffId: 'EMP-9' }));
  });

  it('reads the value from the FLAT shape too — J3-5 admits both, so both must resolve', async () => {
    // The same request body `contextProblems` accepts unwrapped must not produce a DIFFERENT
    // acting user from its envelope twin. This is the half that is easy to omit.
    await service('machine').invokeText(
      agent(frozen(SOLE_KIND_SCHEMA, { kindKey: 'context', field: 'consultant_id' })),
      TENANT,
      { text: 'summarise', context: { consultant_id: 'DR-4471' } },
      'blocking',
    );

    expect(resolveOrProvision).toHaveBeenCalledWith(expect.objectContaining({ staffId: 'DR-4471' }));
  });

  it('still calls the model — resolution is a side condition of the invocation, not a branch', async () => {
    const result = await service('machine').invokeText(
      agent(frozen(SOLE_KIND_SCHEMA, { kindKey: 'context', field: 'consultant_id' })),
      TENANT,
      { text: 'summarise', context: { context: { consultant_id: 'DR-4471' } } },
      'blocking',
    );

    expect(post).toHaveBeenCalledTimes(1);
    expect(result.text).toBe('ok');
  });

  it('resolves on the STREAM path too — both modes go through one gate', async () => {
    post.mockResolvedValue({ data: 'a-readable-stream' });

    await service('machine').invokeText(
      agent(frozen(SOLE_KIND_SCHEMA, { kindKey: 'context', field: 'consultant_id' })),
      TENANT,
      { text: 'summarise', context: { context: { consultant_id: 'DR-4471' } } },
      'stream',
    );

    expect(resolveOrProvision).toHaveBeenCalledWith(expect.objectContaining({ staffId: 'DR-4471' }));
  });
});

describe('everything that legitimately resolves NOTHING', () => {
  it('a HUMAN caller — the caller already IS the clinician (D-5)', async () => {
    await service('human').invokeText(
      agent(frozen(SOLE_KIND_SCHEMA, { kindKey: 'context', field: 'consultant_id' })),
      TENANT,
      { text: 'summarise', context: { context: { consultant_id: 'DR-4471' } } },
      'blocking',
    );

    expect(resolveOrProvision).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(1);
  });

  it('a schema with no marker — absence is "no identity field", never "invalid"', async () => {
    await service('machine').invokeText(
      agent(frozen(SOLE_KIND_SCHEMA)),
      TENANT,
      { text: 'summarise', context: { context: { consultant_id: 'DR-4471' } } },
      'blocking',
    );

    expect(resolveOrProvision).not.toHaveBeenCalled();
  });

  it('an agent that binds no context schema at all', async () => {
    await service('machine').invokeText(agent(null), TENANT, { text: 'summarise' }, 'blocking');

    expect(resolveOrProvision).not.toHaveBeenCalled();
  });

  it('a declared marker whose field this request did not supply (D-2)', async () => {
    await service('machine').invokeText(
      agent(frozen(SOLE_KIND_SCHEMA, { kindKey: 'context', field: 'consultant_id' })),
      TENANT,
      { text: 'summarise', context: { context: { chief_complaint: 'headache' } } },
      'blocking',
    );

    expect(resolveOrProvision).not.toHaveBeenCalled();
  });

  it('a value that is not a string — the payload schema already ruled on its type', async () => {
    // The frozen payload schema types the property as a string, so the CONTEXT GATE refuses the
    // request (400) before identity resolution is ever reached: nothing resolves, nothing provisions.
    await expect(
      service('machine').invokeText(
        agent(frozen(SOLE_KIND_SCHEMA, { kindKey: 'context', field: 'consultant_id' })),
        TENANT,
        { text: 'summarise', context: { context: { consultant_id: 4471 } } },
        'blocking',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(resolveOrProvision).not.toHaveBeenCalled();
  });

  it('a MALFORMED marker — the publish gate refuses those; the runtime must not 500 on one', async () => {
    await service('machine').invokeText(
      agent(frozen(SOLE_KIND_SCHEMA, { kindKey: 'context' })),
      TENANT,
      { text: 'summarise', context: { context: { consultant_id: 'DR-4471' } } },
      'blocking',
    );

    expect(resolveOrProvision).not.toHaveBeenCalled();
    expect(post).toHaveBeenCalledTimes(1);
  });
});

describe('ordering: after the context gate, before the model', () => {
  it('a context the frozen schema refuses provisions NOBODY', async () => {
    // A refused request must not leave a user behind — otherwise a caller could mint users by
    // sending bodies it knows will be rejected.
    await expect(
      service('machine').invokeText(
        agent(frozen({ ...SOLE_KIND_SCHEMA, properties: { context: { type: 'object', properties: {}, additionalProperties: false } } }, { kindKey: 'context', field: 'consultant_id' })),
        TENANT,
        { text: 'summarise', context: { context: { consultant_id: 'DR-4471' } } },
        'blocking',
      ),
    ).rejects.toBeInstanceOf(BadRequestException);

    expect(resolveOrProvision).not.toHaveBeenCalled();
    expect(post).not.toHaveBeenCalled();
  });

  it("a resolver refusal propagates VERBATIM and nothing is spent", async () => {
    resolveOrProvision.mockRejectedValue(new NotFoundException({ message: 'no such staff id', code: 'USER_IDENTITY_UNKNOWN' }));

    await expect(
      service('machine').invokeText(
        agent(frozen(SOLE_KIND_SCHEMA, { kindKey: 'context', field: 'consultant_id' })),
        TENANT,
        { text: 'summarise', context: { context: { consultant_id: 'DR-NOBODY' } } },
        'blocking',
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(post).not.toHaveBeenCalled();
  });

  it('an UNWIRED resolver is a named 503, never a silent skip', async () => {
    // Answering as though the field had not been sent would run the agent under no acting user
    // and leave nothing behind saying a clinician was named.
    await expect(
      service('machine', null).invokeText(
        agent(frozen(SOLE_KIND_SCHEMA, { kindKey: 'context', field: 'consultant_id' })),
        TENANT,
        { text: 'summarise', context: { context: { consultant_id: 'DR-4471' } } },
        'blocking',
      ),
    ).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(post).not.toHaveBeenCalled();
  });

  it('an unwired resolver is IRRELEVANT when the schema declares no marker', async () => {
    // The 503 is about a request that carries an identity, not about the dependency existing.
    await expect(service('machine', null).invokeText(agent(frozen(SOLE_KIND_SCHEMA)), TENANT, { text: 'summarise' }, 'blocking')).resolves.toMatchObject(
      { text: 'ok' },
    );
  });
});
