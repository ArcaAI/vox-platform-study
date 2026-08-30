/**
 * AiRoutingPolicyService — unit tests.
 *
 * Repositories, `IProviderConnectionService`, `EventEmitter2` and `ClsService`
 * are mocked (the `ai-task-default` test style). What is pinned here:
 * the two-tier cascade and the proof that the Global CUSTOMER tenant cannot
 * enter it, most-specific-match selection, the §3A.4 STRICT ruling, the
 * super-admin privilege boundary (403) versus the cross-tenant posture (404),
 * factory use on create, and a sys-event on every mutation.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import { AiExplicitProviderMode, AiRoutingPolicyFactory, AiRoutingPolicyStatus, SYSTEM_TENANT_ID, SysEventType } from '@arcaai/domains';
import { AiRoutingPolicyService } from '../ai-routing-policy.service';
import { RoutingHopRejection } from '../routing-gates';

const TENANT = 'tenant-abc';
const OTHER_TENANT = 'tenant-xyz';
/**
 * The Global CUSTOMER tenant — the platform-admin playground. It is a real
 * customer, NOT a config tier, and must never appear in a runtime cascade.
 * `seed/00-constants.ts` lists it under "Customer Tenants (Global, ArcaAI)".
 */
const GLOBAL_CUSTOMER_TENANT = '50000000-0000-0000-0000-000000000000';

function candidate(overrides: Record<string, unknown> = {}) {
  return { rank: 0, weight: 100, connectionRef: 'azure', model: 'gpt-4o', residency: 'AZURE_US', baaCovered: true, ...overrides };
}

function makeRow(overrides: Record<string, any> = {}) {
  const row = AiRoutingPolicyFactory.CreateAiRoutingPolicy({
    tenantId: overrides.tenantId ?? TENANT,
    taskKey: overrides.taskKey ?? 'text.finalize',
    candidatesJson: (overrides.candidatesJson ?? [candidate()]) as any,
    policyVersion: overrides.policyVersion ?? 1,
    status: overrides.status ?? AiRoutingPolicyStatus.ACTIVE,
    priority: overrides.priority ?? 0,
    killSwitch: overrides.killSwitch ?? false,
    explicitProviderMode: overrides.explicitProviderMode,
    matchJson: (overrides.matchJson ?? null) as any,
    fallbackJson: (overrides.fallbackJson ?? null) as any,
  });
  // The entity's `id`/`version` come from the factory + DB; tests that need a
  // stable id set it here through the same channel a mapper would.
  if (overrides.id) (row as any)._id = overrides.id;
  return row;
}

function makeService(opts: { roles?: string[]; clsTenantId?: string | null; rows?: any[]; connectionSource?: 'tenant' | 'system' | null } = {}) {
  const rows = opts.rows ?? [];
  const repo = {
    findAll: vi.fn().mockResolvedValue(rows),
    create: vi.fn().mockImplementation(async (entity: any) => entity),
    updateWithVersion: vi.fn().mockImplementation(async (_id: string, entity: any) => entity),
    softDelete: vi.fn().mockImplementation(async () => rows[0]),
  };
  const connections = {
    resolveConnection: vi.fn().mockResolvedValue(opts.connectionSource === null ? null : { source: opts.connectionSource ?? 'tenant' }),
  };
  const emitter = { emit: vi.fn() };
  const clsTenantId = opts.clsTenantId === undefined ? TENANT : opts.clsTenantId;
  const cls = {
    get: vi.fn((k: string) => (k === 'user' ? { id: 'u1', roles: opts.roles ?? ['SUPER_ADMIN'] } : k === 'tenantId' ? clsTenantId : undefined)),
  };
  const db = { baseClient: { aiRoutingPolicy: { findMany: vi.fn().mockResolvedValue([]) } } };
  const svc = new AiRoutingPolicyService(repo as any, connections as any, db as any, emitter as any, cls as any);
  return { svc, repo, connections, emitter, cls, db };
}

describe('getEffective — the cascade is request tenant → SYSTEM, and nothing else', () => {
  it("resolves the tenant's OWN policy when it has one", async () => {
    const { svc } = makeService({
      rows: [makeRow({ tenantId: TENANT, candidatesJson: [candidate({ connectionRef: 'tenant-vllm' })] }), makeRow({ tenantId: SYSTEM_TENANT_ID })],
    });
    const result = await svc.getEffective(TENANT, 'text.finalize');
    expect(result.source).toBe('tenant');
    expect(result.primary?.connectionRef).toBe('tenant-vllm');
  });

  it('widens to SYSTEM only on ABSENCE of a tenant policy', async () => {
    const { svc } = makeService({ rows: [makeRow({ tenantId: SYSTEM_TENANT_ID, candidatesJson: [candidate({ connectionRef: 'platform-vllm' })] })] });
    const result = await svc.getEffective(TENANT, 'text.finalize');
    expect(result.source).toBe('system');
    expect(result.primary?.connectionRef).toBe('platform-vllm');
  });

  it('does NOT consult SYSTEM when the tenant HAS an opinion that yields no servable candidate', async () => {
    // Widening happens on absence of the TIER, never on a miss inside a tier
    // the tenant owns — otherwise a tenant's deliberate narrowing silently
    // falls through to the platform default.
    const { svc } = makeService({
      rows: [makeRow({ tenantId: TENANT }), makeRow({ tenantId: SYSTEM_TENANT_ID, candidatesJson: [candidate({ connectionRef: 'platform-vllm' })] })],
      connectionSource: null,
    });
    const result = await svc.getEffective(TENANT, 'text.finalize');
    expect(result.source).toBe('tenant');
    expect(result.rejection?.code).toBe('no_eligible_candidate');
  });

  it('reports no policy when neither tier has one', async () => {
    const { svc } = makeService({ rows: [] });
    const result = await svc.getEffective(TENANT, 'text.finalize');
    expect(result.source).toBeNull();
    expect(result.rejection?.code).toBe('no_policy');
  });

  it('asks the persistence layer for EXACTLY [requestTenant, SYSTEM] — never a third id', async () => {
    const { svc, repo, db, cls } = makeService({ rows: [] });
    await svc.getEffective(TENANT, 'text.finalize');
    // The CLS tenant IS the request tenant, so the read runs on the extended
    // client, which widens to [caller, SYSTEM] itself — the filter therefore
    // pins no tenant at all, and the extension is what cannot admit a third.
    const filters = repo.findAll.mock.calls[0][0].filters;
    expect(filters).not.toHaveProperty('tenantId');
    expect(db.baseClient.aiRoutingPolicy.findMany).not.toHaveBeenCalled();
    expect(cls.get).toHaveBeenCalledWith('tenantId');
  });

  it('CANNOT serve a Global-CUSTOMER-tenant policy to another tenant', async () => {
    // The regression this guards: `50000000-…` is a customer tenant used as a
    // platform-admin playground. A resolver that treated it as a fallback tier
    // would serve one customer's vendor choice for PHI to every other tenant.
    const { svc } = makeService({
      rows: [makeRow({ tenantId: GLOBAL_CUSTOMER_TENANT, candidatesJson: [candidate({ connectionRef: 'playground-provider' })] })],
    });
    const result = await svc.getEffective(TENANT, 'text.finalize');
    expect(result.source).toBeNull();
    expect(result.rejection?.code).toBe('no_policy');
    expect(JSON.stringify(result)).not.toContain('playground-provider');
  });

  it('treats the Global tenant as an ORDINARY customer when it is the requester', async () => {
    // It is a real customer: its own rows serve it, and SYSTEM is still the
    // only widening target. Excluding it entirely would be the opposite bug.
    const { svc } = makeService({
      clsTenantId: GLOBAL_CUSTOMER_TENANT,
      rows: [makeRow({ tenantId: GLOBAL_CUSTOMER_TENANT, candidatesJson: [candidate({ connectionRef: 'playground-provider' })] })],
    });
    const result = await svc.getEffective(GLOBAL_CUSTOMER_TENANT, 'text.finalize');
    expect(result.source).toBe('tenant');
    expect(result.primary?.connectionRef).toBe('playground-provider');
  });

  it('requires super admin to resolve for a tenant other than the caller own', async () => {
    const { svc } = makeService({ roles: [], clsTenantId: TENANT, rows: [] });
    await expect(svc.getEffective(OTHER_TENANT, 'text.finalize')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects an unknown task key', async () => {
    const { svc } = makeService({ rows: [] });
    await expect(svc.getEffective(TENANT, 'text.not-a-task')).rejects.toBeInstanceOf(ArgumentInvalidException);
  });
});

describe('getEffective — most-specific match wins', () => {
  it('prefers the narrower match over the catch-all', async () => {
    const { svc } = makeService({
      rows: [
        makeRow({ tenantId: TENANT, policyVersion: 1, candidatesJson: [candidate({ connectionRef: 'catch-all' })] }),
        makeRow({
          tenantId: TENANT,
          policyVersion: 2,
          matchJson: { models: ['gpt-4o-class'] },
          candidatesJson: [candidate({ connectionRef: 'narrow' })],
        }),
      ],
    });
    const result = await svc.getEffective(TENANT, 'text.finalize', { model: 'gpt-4o-class' });
    expect(result.primary?.connectionRef).toBe('narrow');
  });

  it('breaks an equal-specificity tie with the explicit priority column', async () => {
    const { svc } = makeService({
      rows: [
        makeRow({ tenantId: TENANT, policyVersion: 1, priority: 10, candidatesJson: [candidate({ connectionRef: 'higher-priority' })] }),
        makeRow({ tenantId: TENANT, policyVersion: 2, priority: 0, candidatesJson: [candidate({ connectionRef: 'newer-but-lower' })] }),
      ],
    });
    const result = await svc.getEffective(TENANT, 'text.finalize');
    expect(result.primary?.connectionRef).toBe('higher-priority');
  });

  it('does not let a narrowing row win for a request that never satisfied it', async () => {
    // Silence is not consent: a row narrowed to {"phi":"true"} must not serve a
    // request that said nothing about PHI.
    const { svc } = makeService({
      rows: [
        makeRow({ tenantId: TENANT, policyVersion: 1, candidatesJson: [candidate({ connectionRef: 'catch-all' })] }),
        makeRow({
          tenantId: TENANT,
          policyVersion: 2,
          matchJson: { metadata: { phi: 'true' } },
          candidatesJson: [candidate({ connectionRef: 'phi-only' })],
        }),
      ],
    });
    const result = await svc.getEffective(TENANT, 'text.finalize');
    expect(result.primary?.connectionRef).toBe('catch-all');
  });
});

describe('getEffective — funding is DERIVED, and the chain is gated', () => {
  it('labels a SYSTEM-supplied credential CLOUD and a tenant-supplied one BYOK', async () => {
    const platform = makeService({ rows: [makeRow({ tenantId: TENANT })], connectionSource: 'system' });
    expect((await platform.svc.getEffective(TENANT, 'text.finalize')).primary?.funding).toBe('CLOUD');

    const byok = makeService({ rows: [makeRow({ tenantId: TENANT })], connectionSource: 'tenant' });
    expect((await byok.svc.getEffective(TENANT, 'text.finalize')).primary?.funding).toBe('BYOK');
  });

  it('never stamps funding from the policy row — it reads the CONNECTION cascade', async () => {
    const { svc, connections } = makeService({ rows: [makeRow({ tenantId: TENANT })], connectionSource: 'system' });
    const result = await svc.getEffective(TENANT, 'text.finalize');
    // A SYSTEM-supplied credential on a TENANT-owned policy row still meters
    // CLOUD. If funding were read off the policy row this would say BYOK.
    expect(result.source).toBe('tenant');
    expect(result.primary?.funding).toBe('CLOUD');
    expect(connections.resolveConnection).toHaveBeenCalledWith('llm', 'azure', TENANT);
  });

  it('admits a hop only inside the depth cap, and reports the overflow', async () => {
    const { svc } = makeService({
      rows: [
        makeRow({
          tenantId: TENANT,
          candidatesJson: [candidate(), candidate({ rank: 1, connectionRef: 'bedrock' }), candidate({ rank: 2, connectionRef: 'openai' })],
          fallbackJson: { maxDepth: 1 },
        }),
      ],
    });
    const result = await svc.getEffective(TENANT, 'text.finalize');
    expect(result.fallbackChain.map((c) => c.connectionRef)).toEqual(['bedrock']);
    expect(result.rejectedCandidates).toEqual([
      expect.objectContaining({ connectionRef: 'openai', reason: RoutingHopRejection.FallbackDepthExceeded }),
    ]);
  });

  it('has NO fallback chain at all when the policy declares no fallback contract', async () => {
    const { svc } = makeService({
      rows: [makeRow({ tenantId: TENANT, candidatesJson: [candidate(), candidate({ rank: 1, connectionRef: 'bedrock' })] })],
    });
    const result = await svc.getEffective(TENANT, 'text.finalize');
    expect(result.fallbackChain).toEqual([]);
  });

  it('reports a gate the author explicitly relaxed', async () => {
    const { svc } = makeService({
      rows: [makeRow({ tenantId: TENANT, fallbackJson: { maxDepth: 1, requireBaaCovered: false } })],
    });
    expect((await svc.getEffective(TENANT, 'text.finalize')).relaxedGates).toEqual(['requireBaaCovered']);
  });

  it('refuses to serve a policy whose kill switch is engaged', async () => {
    const { svc } = makeService({ rows: [makeRow({ tenantId: TENANT, killSwitch: true })] });
    const result = await svc.getEffective(TENANT, 'text.finalize');
    expect(result.rejection?.code).toBe('kill_switch_engaged');
    expect(result.primary).toBeNull();
  });
});

describe('getEffective — §3A.4 explicit provider is honoured, STRICT by default', () => {
  const twoCandidates = [candidate(), candidate({ rank: 1, connectionRef: 'bedrock', model: 'claude-sonnet-4' })];

  it('serves the provider the caller named', async () => {
    const { svc } = makeService({ rows: [makeRow({ tenantId: TENANT, candidatesJson: twoCandidates, fallbackJson: { maxDepth: 2 } })] });
    const result = await svc.getEffective(TENANT, 'text.finalize', { explicitProvider: 'bedrock' });
    expect(result.primary?.connectionRef).toBe('bedrock');
  });

  it('returns provider_unavailable — never a substitution — when the named provider is down', async () => {
    const { svc } = makeService({ rows: [makeRow({ tenantId: TENANT, candidatesJson: twoCandidates, fallbackJson: { maxDepth: 2 } })] });
    const result = await svc.getEffective(TENANT, 'text.finalize', { explicitProvider: 'bedrock', unhealthyProviders: ['bedrock'] });
    expect(result.rejection?.code).toBe('provider_unavailable');
    expect(result.rejection?.retryable).toBe(true);
    expect(result.primary).toBeNull();
    expect(result.fallbackChain).toEqual([]);
  });

  it('closes the fallback chain entirely under STRICT even when the named provider IS healthy', async () => {
    const { svc } = makeService({ rows: [makeRow({ tenantId: TENANT, candidatesJson: twoCandidates, fallbackJson: { maxDepth: 2 } })] });
    const result = await svc.getEffective(TENANT, 'text.finalize', { explicitProvider: 'azure' });
    expect(result.fallbackChain).toEqual([]);
    expect(result.rejectedCandidates).toEqual([
      expect.objectContaining({ connectionRef: 'bedrock', reason: RoutingHopRejection.ExplicitProviderStrict }),
    ]);
  });

  it('opens the chain under STRICT_UNLESS_OPTED_IN only when the request opts in', async () => {
    const rows = [
      makeRow({
        tenantId: TENANT,
        candidatesJson: twoCandidates,
        fallbackJson: { maxDepth: 2 },
        explicitProviderMode: AiExplicitProviderMode.STRICT_UNLESS_OPTED_IN,
      }),
    ];
    const closed = await makeService({ rows }).svc.getEffective(TENANT, 'text.finalize', { explicitProvider: 'azure' });
    expect(closed.fallbackChain).toEqual([]);

    const opened = await makeService({ rows }).svc.getEffective(TENANT, 'text.finalize', { explicitProvider: 'azure', allowFallbacks: true });
    expect(opened.fallbackChain.map((c) => c.connectionRef)).toEqual(['bedrock']);
  });

  it('opting in still cannot cross a hard gate', async () => {
    const rows = [
      makeRow({
        tenantId: TENANT,
        candidatesJson: [candidate(), candidate({ rank: 1, connectionRef: 'bedrock', residency: 'AWS_EU' })],
        fallbackJson: { maxDepth: 2 },
        explicitProviderMode: AiExplicitProviderMode.STRICT_UNLESS_OPTED_IN,
      }),
    ];
    const result = await makeService({ rows }).svc.getEffective(TENANT, 'text.finalize', { explicitProvider: 'azure', allowFallbacks: true });
    expect(result.fallbackChain).toEqual([]);
    expect(result.rejectedCandidates).toEqual([
      expect.objectContaining({ connectionRef: 'bedrock', reason: RoutingHopRejection.ResidencyClassMismatch }),
    ]);
  });

  it('reports provider_not_in_policy for a provider the policy never listed', async () => {
    const { svc } = makeService({ rows: [makeRow({ tenantId: TENANT, candidatesJson: twoCandidates })] });
    const result = await svc.getEffective(TENANT, 'text.finalize', { explicitProvider: 'never-heard-of-it' });
    expect(result.rejection?.code).toBe('provider_not_in_policy');
  });
});

describe('writes — super admin only (403), cross-tenant id (404)', () => {
  const dto = { taskKey: 'text.finalize', candidates: [candidate()] };

  it.each([
    ['create', (s: AiRoutingPolicyService) => s.create(TENANT, dto as any)],
    ['update', (s: AiRoutingPolicyService) => s.update('p1', TENANT, { killSwitch: true, expectedVersion: 1 })],
    ['activate', (s: AiRoutingPolicyService) => s.activate('p1', TENANT, 1)],
    ['deleteById', (s: AiRoutingPolicyService) => s.deleteById('p1', TENANT)],
    ['list', (s: AiRoutingPolicyService) => s.list(TENANT)],
    ['getById', (s: AiRoutingPolicyService) => s.getById('p1', TENANT)],
  ])('%s throws ForbiddenException for a non-super-admin — a PRIVILEGE rule, so 403 not 404', async (_name, call) => {
    const { svc } = makeService({ roles: ['TENANT_ADMIN'], rows: [] });
    await expect(call(svc)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('answers 404 — never 403 — for a policy owned by another tenant', async () => {
    // 404-over-403: a privilege message would confirm the id exists somewhere.
    const { svc } = makeService({ rows: [makeRow({ tenantId: OTHER_TENANT })] });
    await expect(svc.getById('p1', TENANT)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('answers 404 when no row exists at all — the same answer, so absence is indistinguishable', async () => {
    const { svc } = makeService({ rows: [] });
    await expect(svc.getById('p1', TENANT)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('create', () => {
  it('builds the entity through the FACTORY and persists it as a DRAFT', async () => {
    const spy = vi.spyOn(AiRoutingPolicyFactory, 'CreateAiRoutingPolicy');
    const { svc, repo } = makeService({ rows: [] });
    const saved = await svc.create(TENANT, { taskKey: 'text.finalize', candidates: [candidate()] } as any);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(repo.create).toHaveBeenCalledTimes(1);
    expect(saved.status).toBe(AiRoutingPolicyStatus.DRAFT);
    expect(saved.policyVersion).toBe(1);
    spy.mockRestore();
  });

  it('takes the next authored revision after the highest existing one', async () => {
    const { svc } = makeService({ rows: [makeRow({ tenantId: TENANT, policyVersion: 7 })] });
    const saved = await svc.create(TENANT, { taskKey: 'text.finalize', candidates: [candidate()] } as any);
    expect(saved.policyVersion).toBe(8);
  });

  it('broadcasts ResourceCreated with a before/after audit pair (§3A.8)', async () => {
    const { svc, emitter } = makeService({ rows: [] });
    await svc.create(TENANT, { taskKey: 'text.finalize', candidates: [candidate()] } as any);
    const [type, payload] = emitter.emit.mock.calls[0];
    expect(type).toBe(SysEventType.ResourceCreated);
    expect(payload.data.before).toBeNull();
    expect(payload.data.after).toMatchObject({ taskKey: 'text.finalize', status: AiRoutingPolicyStatus.DRAFT });
  });

  it('refuses a candidate list where nothing survives parsing rather than persisting a policy that cannot route', async () => {
    const { svc } = makeService({ rows: [] });
    // `baaCovered` missing — the §3A.4 BAA gate reads it, so it is never defaulted.
    await expect(
      svc.create(TENANT, { taskKey: 'text.finalize', candidates: [{ connectionRef: 'azure', model: 'gpt-4o', residency: 'AZURE_US' }] } as any),
    ).rejects.toBeInstanceOf(ArgumentInvalidException);
  });

  it('refuses a revision number that already exists for this (tenant, task)', async () => {
    const { svc } = makeService({ rows: [makeRow({ tenantId: TENANT, policyVersion: 3 })] });
    await expect(svc.create(TENANT, { taskKey: 'text.finalize', candidates: [candidate()], policyVersion: 3 } as any)).rejects.toBeInstanceOf(
      ArgumentInvalidException,
    );
  });
});

describe('update — a served revision is a rollback target, not a scratchpad', () => {
  it('allows a full edit on a DRAFT', async () => {
    const draft = makeRow({ tenantId: TENANT, status: AiRoutingPolicyStatus.DRAFT });
    const { svc, repo, emitter } = makeService({ rows: [draft] });
    await svc.update(draft.id, TENANT, { priority: 5, expectedVersion: draft.version });
    expect(repo.updateWithVersion).toHaveBeenCalledTimes(1);
    expect(emitter.emit.mock.calls[0][0]).toBe(SysEventType.ResourceUpdated);
  });

  it('REFUSES a routing-semantics edit on an ACTIVE revision', async () => {
    const active = makeRow({ tenantId: TENANT, status: AiRoutingPolicyStatus.ACTIVE });
    const { svc } = makeService({ rows: [active] });
    await expect(svc.update(active.id, TENANT, { priority: 5, expectedVersion: active.version })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('still allows the kill switch to be flipped on an ACTIVE revision', async () => {
    const active = makeRow({ tenantId: TENANT, status: AiRoutingPolicyStatus.ACTIVE });
    const { svc, repo } = makeService({ rows: [active] });
    await svc.update(active.id, TENANT, { killSwitch: true, expectedVersion: active.version });
    expect(repo.updateWithVersion).toHaveBeenCalledTimes(1);
  });

  it('carries before/after on the audit event', async () => {
    const draft = makeRow({ tenantId: TENANT, status: AiRoutingPolicyStatus.DRAFT, priority: 0 });
    const { svc, emitter } = makeService({ rows: [draft] });
    await svc.update(draft.id, TENANT, { priority: 9, expectedVersion: draft.version });
    const payload = emitter.emit.mock.calls[0][1];
    expect(payload.data.before.priority).toBe(0);
    expect(payload.data.after.priority).toBe(9);
  });
});

describe('activate — supersede-only promotion (§3A.8)', () => {
  it('promotes the DRAFT, archives its predecessor and records the lineage', async () => {
    const draft = makeRow({ tenantId: TENANT, status: AiRoutingPolicyStatus.DRAFT, policyVersion: 2 });
    const previous = makeRow({ tenantId: TENANT, status: AiRoutingPolicyStatus.ACTIVE, policyVersion: 1 });
    const { svc, repo, emitter } = makeService({ rows: [] });
    // First read loads the DRAFT by id; the second finds the ACTIVE predecessor.
    repo.findAll.mockResolvedValueOnce([draft]).mockResolvedValueOnce([previous]);

    const activated = await svc.activate(draft.id, TENANT, draft.version);

    expect(previous.status).toBe(AiRoutingPolicyStatus.ARCHIVED);
    expect(activated.status).toBe(AiRoutingPolicyStatus.ACTIVE);
    expect(activated.supersedesVersion).toBe(1);
    expect(activated.activatedAt).not.toBeNull();
    // The predecessor is ARCHIVED, never deleted — it stays addressable.
    expect(repo.softDelete).not.toHaveBeenCalled();
    expect(emitter.emit).toHaveBeenCalledTimes(2);
    expect(emitter.emit.mock.calls[1][1].data.reason).toBe('activated');
  });

  it('refuses to activate anything that is not a DRAFT', async () => {
    const active = makeRow({ tenantId: TENANT, status: AiRoutingPolicyStatus.ACTIVE });
    const { svc } = makeService({ rows: [active] });
    await expect(svc.activate(active.id, TENANT, active.version)).rejects.toBeInstanceOf(ArgumentInvalidException);
  });
});

describe('deleteById', () => {
  it('soft-deletes and broadcasts ResourceDeleted', async () => {
    const row = makeRow({ tenantId: TENANT });
    const { svc, repo, emitter } = makeService({ rows: [row] });
    await svc.deleteById(row.id, TENANT);
    expect(repo.softDelete).toHaveBeenCalledWith(row.id, 'u1', undefined);
    expect(emitter.emit.mock.calls[0][0]).toBe(SysEventType.ResourceDeleted);
  });
});
