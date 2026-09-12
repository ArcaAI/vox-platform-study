/**
 * AiRoutingPolicyService — unit tests.
 *
 * Repositories, `IProviderConnectionService`, `CoreUnitOfWorkService`,
 * `EventEmitter2` and `ClsService` are mocked (the `ai-task-default` test
 * style). What is pinned here:
 *
 *   * the two-tier cascade and the proof that the Global CUSTOMER tenant
 *     `50000000-…` cannot enter it — at any point, in any response;
 * * default ELECTION: `isDefault` outranks ordering, the unset and
 *     the set happen in ONE transaction, and the operation is idempotent;
 *   * funding is DERIVED from the connection cascade, never stamped from the row;
 *   * PROMOTION copies a configuration WITHOUT its credential and never lands
 *     elected;
 *   * EXPORT carries no recoverable secret — asserted structurally, not by
 *     reading the builder;
 * * most-specific-match selection, the STRICT ruling, the super-admin
 *     privilege boundary (403) versus the cross-tenant posture (404), factory
 *     use on create, and a sys-event on every mutation.
 *
 * ## The grain these tests describe
 *
 * re-grained the table: ONE ROW IS ONE PROVIDER CONFIGURATION, and the
 * ordered chain is the SET of rows sharing `(tenantId, taskKey)`. Where the
 * suite built one row carrying a `candidatesJson` array, these helpers
 * build N rows — which is why `makeChain` exists.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import { AiExplicitProviderMode, AiRoutingPolicyFactory, AiRoutingPolicyStatus, SYSTEM_TENANT_ID, SysEventType } from '@arcaai/domains';
import { AiRoutingPolicyService } from '../ai-routing-policy.service';
import { RoutingHopRejection } from '../routing-gates';
import { assertNoSecretMaterial } from '../provider-configuration';

const TENANT = 'tenant-abc';
const OTHER_TENANT = 'tenant-xyz';
/**
 * The Global CUSTOMER tenant — the platform-admin playground. It is a real
 * customer, NOT a config tier, and must never appear in a runtime cascade.
 * `seed/00-constants.ts` lists it under "Customer Tenants (Global, ArcaAI)".
 */
const GLOBAL_CUSTOMER_TENANT = '50000000-0000-0000-0000-000000000000';

/**
 * Build ONE provider configuration row.
 *
 * `connectionRef` and `model` are given as NAMES and encoded into the two FK
 * columns as `conn:<provider>` / `model:<slug>`; the repository mocks below
 * decode them. That keeps every assertion in this file written in the names the
 * plane actually speaks, while still exercising the real FK → name resolution
 * path (`resolveRefs`) rather than stubbing it out.
 */
function makeConfig(overrides: Record<string, any> = {}) {
  const row = AiRoutingPolicyFactory.CreateAiRoutingPolicy({
    tenantId: overrides.tenantId ?? TENANT,
    taskKey: overrides.taskKey ?? 'harness.judge',
    providerConnectionId: overrides.connectionRef === null ? null : `conn:${overrides.connectionRef ?? 'azure'}`,
    modelId: `model:${overrides.model ?? 'gpt-4o'}`,
    residency: overrides.residency ?? 'AZURE_US',
    baaCovered: overrides.baaCovered ?? true,
    isDefault: overrides.isDefault ?? false,
    enabled: overrides.enabled ?? true,
    priority: overrides.priority ?? 0,
    policyVersion: overrides.policyVersion ?? 1,
    status: overrides.status ?? AiRoutingPolicyStatus.ACTIVE,
    killSwitch: overrides.killSwitch ?? false,
    explicitProviderMode: overrides.explicitProviderMode,
    matchJson: (overrides.matchJson ?? null) as any,
    fallbackJson: (overrides.fallbackJson ?? null) as any,
  });
  if (overrides.id) (row as any)._id = overrides.id;
  return row;
}

/**
 * Build an ordered CHAIN for one selection — the replacement for a
 * single row carrying a `candidatesJson` array.
 *
 * The first entry is elected (`isDefault`) and carries the shared policy-level
 * knobs (`fallbackJson`, `matchJson`, `explicitProviderMode`), exactly as the
 * resolver reads them off the winning row. Later entries take ascending
 * `priority`, which is the chain position.
 */
function makeChain(shared: Record<string, any>, candidates: Record<string, any>[]) {
  return candidates.map((c, index) =>
    makeConfig({
      ...shared,
      ...c,
      priority: c.priority ?? index,
      isDefault: index === 0,
      policyVersion: c.policyVersion ?? shared.policyVersion ?? 1,
      // Policy-level knobs live on the elected row, which is the one the
      // resolver reads them from.
      fallbackJson: index === 0 ? shared.fallbackJson : null,
      matchJson: index === 0 ? shared.matchJson : null,
    }),
  );
}

function makeService(
  opts: {
    roles?: string[];
    clsTenantId?: string | null;
    rows?: any[];
    connectionSource?: 'tenant' | 'system' | null;
    connectionHasKey?: boolean;
    /** The owning tenant of the model a write binds — drives the 404-over-403 case. */
    modelTenantId?: string | null;
    /** The `AiModel.taskType` a write binds — drives the compatibility case. */
    modelTaskType?: string;
  } = {},
) {
  const rows = opts.rows ?? [];
  const repo = {
    findAll: vi.fn().mockResolvedValue(rows),
    // `getEffective` reads the chain through this. The mock honours
    // the tenant-id SET it is handed, which is what makes the cascade tests
    // meaningful: a resolver that quietly added a third tier would still be
    // handed only the two ids the service built.
    findCandidates: vi
      .fn()
      .mockImplementation(async (tenantIds: string[], taskKey: string) =>
        rows.filter(
          (r: any) => tenantIds.includes(r.tenantId) && r.taskKey === taskKey && r.status === AiRoutingPolicyStatus.ACTIVE && r.enabled !== false,
        ),
      ),
    clearDefaultFor: vi.fn().mockResolvedValue(1),
    create: vi.fn().mockImplementation(async (entity: any) => entity),
    updateWithVersion: vi.fn().mockImplementation(async (_id: string, entity: any) => entity),
    softDelete: vi.fn().mockImplementation(async () => rows[0]),
  };
  // Decode the `conn:`/`model:` FK ids the helpers above encode.
  const providerConnections = {
    findById: vi.fn().mockImplementation(async (id: string) => ({
      id,
      provider: String(id).replace(/^conn:/, ''),
      service: 'llm',
      encryptedApiKey: opts.connectionHasKey === false ? null : new Uint8Array([1, 2, 3]),
      keyVersion: 3,
    })),
  };
  const models = {
    findById: vi.fn().mockImplementation(async (id: string) => ({ id, slug: String(id).replace(/^model:/, '') })),
    // The WRITE-time lookup. It carries `tenantId` and `taskType` because the
    // write check reads both: visibility (404-over-403) and task compatibility.
    // `harness.judge` — the task key every create/update fixture in this file
    // uses — requires TEXT_GENERATION.
    findByIdOrNull: vi.fn().mockImplementation(async (id: string) => ({
      id,
      slug: String(id).replace(/^model:/, ''),
      tenantId: opts.modelTenantId ?? SYSTEM_TENANT_ID,
      taskType: opts.modelTaskType ?? 'TEXT_GENERATION',
    })),
    findBySlug: vi.fn().mockImplementation(async (_tenantId: string, slug: string) => ({ id: `model:${slug}`, slug })),
  };
  const connections = {
    resolveConnection: vi.fn().mockResolvedValue(opts.connectionSource === null ? null : { source: opts.connectionSource ?? 'tenant' }),
    findRow: vi.fn().mockResolvedValue({ id: 'conn:azure' }),
    // TASK-958 D-11 — `promote` re-points at the TARGET tenant's DEFAULT
    // connection for the provider, not at whatever row the slug happens to name.
    findDefaultRow: vi.fn().mockResolvedValue({ id: 'conn:azure' }),
  };
  const emitter = { emit: vi.fn() };
  const clsTenantId = opts.clsTenantId === undefined ? TENANT : opts.clsTenantId;
  const cls = {
    get: vi.fn((k: string) => (k === 'user' ? { id: 'u1', roles: opts.roles ?? ['SUPER_ADMIN'] } : k === 'tenantId' ? clsTenantId : undefined)),
  };
  const db = { baseClient: { aiRoutingPolicy: { findMany: vi.fn().mockResolvedValue([]) } } };
  const tx = { aiRoutingPolicy: {} };
  const unitOfWork = { runInTransaction: vi.fn().mockImplementation(async (work: any) => work(tx)) };
  const svc = new AiRoutingPolicyService(
    repo as any,
    providerConnections as any,
    models as any,
    connections as any,
    db as any,
    unitOfWork as any,
    emitter as any,
    cls as any,
  );
  return { svc, repo, providerConnections, models, connections, emitter, cls, db, unitOfWork, tx };
}

describe('getEffective — the cascade is request tenant → SYSTEM, and nothing else', () => {
  it("resolves the tenant's OWN configuration when it has one", async () => {
    const { svc } = makeService({
      rows: [
        makeConfig({ tenantId: TENANT, connectionRef: 'tenant-vllm', isDefault: true }),
        makeConfig({ tenantId: SYSTEM_TENANT_ID, isDefault: true }),
      ],
    });
    const result = await svc.getEffective(TENANT, 'harness.judge');
    expect(result.source).toBe('tenant');
    expect(result.primary?.connectionRef).toBe('tenant-vllm');
  });

  it('widens to SYSTEM only on ABSENCE of a tenant configuration', async () => {
    const { svc } = makeService({ rows: [makeConfig({ tenantId: SYSTEM_TENANT_ID, connectionRef: 'platform-vllm', isDefault: true })] });
    const result = await svc.getEffective(TENANT, 'harness.judge');
    expect(result.source).toBe('system');
    expect(result.primary?.connectionRef).toBe('platform-vllm');
  });

  it('does NOT consult SYSTEM when the tenant HAS an opinion that yields no servable candidate', async () => {
    // Widening happens on absence of the TIER, never on a miss inside a tier
    // the tenant owns — otherwise a tenant's deliberate narrowing silently
    // falls through to the platform default.
    const { svc } = makeService({
      rows: [
        makeConfig({ tenantId: TENANT, isDefault: true }),
        makeConfig({ tenantId: SYSTEM_TENANT_ID, connectionRef: 'platform-vllm', isDefault: true }),
      ],
      connectionSource: null,
    });
    const result = await svc.getEffective(TENANT, 'harness.judge');
    expect(result.source).toBe('tenant');
    expect(result.rejection?.code).toBe('no_eligible_candidate');
  });

  it('reports no policy when neither tier has one', async () => {
    const { svc } = makeService({ rows: [] });
    const result = await svc.getEffective(TENANT, 'harness.judge');
    expect(result.source).toBeNull();
    expect(result.rejection?.code).toBe('no_policy');
  });

  it('asks the persistence layer for EXACTLY [requestTenant, SYSTEM] — never a third id', async () => {
    const { svc, repo } = makeService({ rows: [] });
    await svc.getEffective(TENANT, 'harness.judge');
    const [tenantIds] = repo.findCandidates.mock.calls[0];
    expect(tenantIds).toEqual([TENANT, SYSTEM_TENANT_ID]);
    expect(tenantIds).toHaveLength(2);
  });

  it('CANNOT serve a Global-CUSTOMER-tenant configuration to another tenant', async () => {
    // The regression this guards: `50000000-…` is a customer tenant used as a
    // platform-admin playground. A resolver that treated it as a fallback tier
    // would serve one customer's vendor choice for PHI to every other tenant.
    const { svc, repo } = makeService({
      rows: [makeConfig({ tenantId: GLOBAL_CUSTOMER_TENANT, connectionRef: 'playground-provider', isDefault: true })],
    });
    const result = await svc.getEffective(TENANT, 'harness.judge');
    expect(result.source).toBeNull();
    expect(result.rejection?.code).toBe('no_policy');
    expect(JSON.stringify(result)).not.toContain('playground-provider');
    // Belt and braces: the id was never even ASKED for, so the exclusion does
    // not depend on a filter downstream of the read.
    expect(repo.findCandidates.mock.calls[0][0]).not.toContain(GLOBAL_CUSTOMER_TENANT);
  });

  it('never names the Global tenant in ANY read this service performs for another tenant', async () => {
    // A structural sweep rather than one assertion: every tenant-id argument to
    // every persistence call is checked, so a future code path that widened the
    // cascade would fail here even if it did not change the response shape.
    const { svc, repo } = makeService({
      rows: [makeConfig({ tenantId: GLOBAL_CUSTOMER_TENANT, isDefault: true }), makeConfig({ tenantId: SYSTEM_TENANT_ID, isDefault: true })],
    });
    await svc.getEffective(TENANT, 'harness.judge');
    const everyArgument = JSON.stringify([...repo.findCandidates.mock.calls, ...repo.findAll.mock.calls]);
    expect(everyArgument).not.toContain(GLOBAL_CUSTOMER_TENANT);
  });

  it('treats the Global tenant as an ORDINARY customer when it is the requester', async () => {
    // It is a real customer: its own rows serve it, and SYSTEM is still the
    // only widening target. Excluding it entirely would be the opposite bug.
    const { svc } = makeService({
      clsTenantId: GLOBAL_CUSTOMER_TENANT,
      rows: [makeConfig({ tenantId: GLOBAL_CUSTOMER_TENANT, connectionRef: 'playground-provider', isDefault: true })],
    });
    const result = await svc.getEffective(GLOBAL_CUSTOMER_TENANT, 'harness.judge');
    expect(result.source).toBe('tenant');
    expect(result.primary?.connectionRef).toBe('playground-provider');
  });

  it('requires super admin to resolve for a tenant other than the caller own', async () => {
    const { svc } = makeService({ roles: [], clsTenantId: TENANT, rows: [] });
    await expect(svc.getEffective(OTHER_TENANT, 'harness.judge')).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('rejects an unknown task key', async () => {
    const { svc } = makeService({ rows: [] });
    await expect(svc.getEffective(TENANT, 'text.not-a-task')).rejects.toBeInstanceOf(ArgumentInvalidException);
  });
});

describe('getEffective — the ELECTED default outranks ordering ', () => {
  it('serves the row carrying isDefault even when another row sorts first', async () => {
    // The whole point of the election: an administrator's explicit choice is
    // not a tie-break, it is the answer.
    const { svc } = makeService({
      rows: [
        makeConfig({ tenantId: TENANT, connectionRef: 'first-by-priority', priority: 0, isDefault: false }),
        makeConfig({ tenantId: TENANT, connectionRef: 'the-elected-one', priority: 99, isDefault: true }),
      ],
    });
    const result = await svc.getEffective(TENANT, 'harness.judge');
    expect(result.primary?.connectionRef).toBe('the-elected-one');
  });

  it('falls back to chain ORDER when no row is elected', async () => {
    const { svc } = makeService({
      rows: [
        makeConfig({ tenantId: TENANT, connectionRef: 'later', priority: 5, isDefault: false }),
        makeConfig({ tenantId: TENANT, connectionRef: 'earlier', priority: 1, isDefault: false }),
      ],
    });
    const result = await svc.getEffective(TENANT, 'harness.judge');
    // LOWER priority serves first — `priority` is the chain POSITION at this
    // grain, replacing the old candidate `rank`.
    expect(result.primary?.connectionRef).toBe('earlier');
  });

  it('skips a candidate an administrator switched off', async () => {
    const { svc } = makeService({
      rows: [
        makeConfig({ tenantId: TENANT, connectionRef: 'parked', priority: 0, enabled: false }),
        makeConfig({ tenantId: TENANT, connectionRef: 'live', priority: 1, isDefault: true }),
      ],
    });
    const result = await svc.getEffective(TENANT, 'harness.judge');
    expect(result.primary?.connectionRef).toBe('live');
    expect(JSON.stringify(result)).not.toContain('parked');
  });
});

describe('getEffective — most-specific match wins', () => {
  it('prefers the narrower match over the catch-all', async () => {
    const { svc } = makeService({
      rows: [
        makeConfig({ tenantId: TENANT, policyVersion: 1, connectionRef: 'catch-all' }),
        makeConfig({ tenantId: TENANT, policyVersion: 2, matchJson: { models: ['gpt-4o-class'] }, connectionRef: 'narrow' }),
      ],
    });
    const result = await svc.getEffective(TENANT, 'harness.judge', { model: 'gpt-4o-class' });
    expect(result.primary?.connectionRef).toBe('narrow');
  });

  it('breaks an equal-specificity tie with the priority column — LOWER first', async () => {
    // ⚠ SEMANTIC REDEFINITION, deliberate and recorded .
    // used `priority` as a policy-level tie-break where HIGHER won.
    // makes it the CHAIN POSITION, replacing the old candidate `rank`,
    // so LOWER serves first. Safe to redefine because `AiRoutingPolicy` had zero
    // runtime readers and zero rows when the grain changed.
    const { svc } = makeService({
      rows: [
        makeConfig({ tenantId: TENANT, policyVersion: 1, priority: 10, connectionRef: 'later-in-chain' }),
        makeConfig({ tenantId: TENANT, policyVersion: 2, priority: 0, connectionRef: 'first-in-chain' }),
      ],
    });
    const result = await svc.getEffective(TENANT, 'harness.judge');
    expect(result.primary?.connectionRef).toBe('first-in-chain');
  });

  it('does not let a narrowing row win for a request that never satisfied it', async () => {
    // Silence is not consent: a row narrowed to {"phi":"true"} must not serve a
    // request that said nothing about PHI.
    const { svc } = makeService({
      rows: [
        makeConfig({ tenantId: TENANT, policyVersion: 1, connectionRef: 'catch-all' }),
        makeConfig({ tenantId: TENANT, policyVersion: 2, matchJson: { metadata: { phi: 'true' } }, connectionRef: 'phi-only' }),
      ],
    });
    const result = await svc.getEffective(TENANT, 'harness.judge');
    expect(result.primary?.connectionRef).toBe('catch-all');
  });
});

describe('getEffective — funding is DERIVED, and the chain is gated', () => {
  it('labels a SYSTEM-supplied credential CLOUD and a tenant-supplied one BYOK', async () => {
    const platform = makeService({ rows: [makeConfig({ tenantId: TENANT, isDefault: true })], connectionSource: 'system' });
    expect((await platform.svc.getEffective(TENANT, 'harness.judge')).primary?.funding).toBe('CLOUD');

    const byok = makeService({ rows: [makeConfig({ tenantId: TENANT, isDefault: true })], connectionSource: 'tenant' });
    expect((await byok.svc.getEffective(TENANT, 'harness.judge')).primary?.funding).toBe('BYOK');
  });

  it('never stamps funding from the configuration row — it reads the CONNECTION cascade', async () => {
    const { svc, connections } = makeService({ rows: [makeConfig({ tenantId: TENANT, isDefault: true })], connectionSource: 'system' });
    const result = await svc.getEffective(TENANT, 'harness.judge');
    // A SYSTEM-supplied credential on a TENANT-owned configuration row still
    // meters CLOUD. If funding were read off the row this would say BYOK.
    expect(result.source).toBe('tenant');
    expect(result.primary?.funding).toBe('CLOUD');
    expect(connections.resolveConnection).toHaveBeenCalledWith('llm', 'azure', TENANT);
  });

  it('honours a DISABLED connection as a veto in BOTH tiers', async () => {
    // `resolveConnection` returning null is how AiProviderConnection's third
    // state (disabled = veto) reaches this plane. It must fail the candidate
    // closed, in the tenant tier AND in the platform tier — never fall through
    // to "some other provider will do".
    const tenantTier = makeService({ rows: [makeConfig({ tenantId: TENANT, isDefault: true })], connectionSource: null });
    expect((await tenantTier.svc.getEffective(TENANT, 'harness.judge')).rejection?.code).toBe('no_eligible_candidate');

    const systemTier = makeService({ rows: [makeConfig({ tenantId: SYSTEM_TENANT_ID, isDefault: true })], connectionSource: null });
    expect((await systemTier.svc.getEffective(TENANT, 'harness.judge')).rejection?.code).toBe('no_eligible_candidate');
  });

  it('serves a configuration that has NO provider connection at all', async () => {
    // The `nlp.*` / `guardrail.*` selections run in-process inside `apps/nlp`
    // and are served by no connection. They are not "unfunded" — they are not
    // vendor-paid — and they must keep resolving exactly as they did through
    // `AiTaskDefault`.
    const { svc } = makeService({
      rows: [makeConfig({ tenantId: SYSTEM_TENANT_ID, taskKey: 'nlp.ner', connectionRef: null, model: 'medical-ner', isDefault: true })],
    });
    const result = await svc.getEffective(TENANT, 'nlp.ner');
    expect(result.rejection).toBeNull();
    expect(result.primary?.funding).toBe('CLOUD');
    expect(result.primary?.model).toBe('medical-ner');
  });

  it('admits a hop only inside the depth cap, and reports the overflow', async () => {
    const { svc } = makeService({
      rows: makeChain({ tenantId: TENANT, fallbackJson: { maxDepth: 1 } }, [
        { connectionRef: 'azure' },
        { connectionRef: 'bedrock' },
        { connectionRef: 'openai' },
      ]),
    });
    const result = await svc.getEffective(TENANT, 'harness.judge');
    expect(result.fallbackChain.map((c) => c.connectionRef)).toEqual(['bedrock']);
    expect(result.rejectedCandidates).toEqual([
      expect.objectContaining({ connectionRef: 'openai', reason: RoutingHopRejection.FallbackDepthExceeded }),
    ]);
  });

  it('has NO fallback chain at all when the elected row declares no fallback contract', async () => {
    const { svc } = makeService({ rows: makeChain({ tenantId: TENANT }, [{ connectionRef: 'azure' }, { connectionRef: 'bedrock' }]) });
    const result = await svc.getEffective(TENANT, 'harness.judge');
    expect(result.fallbackChain).toEqual([]);
  });

  it('reports a gate the author explicitly relaxed', async () => {
    const { svc } = makeService({
      rows: [makeConfig({ tenantId: TENANT, isDefault: true, fallbackJson: { maxDepth: 1, requireBaaCovered: false } })],
    });
    expect((await svc.getEffective(TENANT, 'harness.judge')).relaxedGates).toEqual(['requireBaaCovered']);
  });

  it('refuses to serve a configuration whose kill switch is engaged', async () => {
    const { svc } = makeService({ rows: [makeConfig({ tenantId: TENANT, isDefault: true, killSwitch: true })] });
    const result = await svc.getEffective(TENANT, 'harness.judge');
    expect(result.rejection?.code).toBe('kill_switch_engaged');
    expect(result.primary).toBeNull();
  });
});

describe('getEffective — explicit provider is honoured, STRICT by default', () => {
  const two = [{ connectionRef: 'azure' }, { connectionRef: 'bedrock', model: 'claude-sonnet-4' }];

  it('serves the provider the caller named', async () => {
    const { svc } = makeService({ rows: makeChain({ tenantId: TENANT, fallbackJson: { maxDepth: 2 } }, two) });
    const result = await svc.getEffective(TENANT, 'harness.judge', { explicitProvider: 'bedrock' });
    expect(result.primary?.connectionRef).toBe('bedrock');
  });

  it('returns provider_unavailable — never a substitution — when the named provider is down', async () => {
    const { svc } = makeService({ rows: makeChain({ tenantId: TENANT, fallbackJson: { maxDepth: 2 } }, two) });
    const result = await svc.getEffective(TENANT, 'harness.judge', { explicitProvider: 'bedrock', unhealthyProviders: ['bedrock'] });
    expect(result.rejection?.code).toBe('provider_unavailable');
    expect(result.rejection?.retryable).toBe(true);
    expect(result.primary).toBeNull();
    expect(result.fallbackChain).toEqual([]);
  });

  it('closes the fallback chain entirely under STRICT even when the named provider IS healthy', async () => {
    const { svc } = makeService({ rows: makeChain({ tenantId: TENANT, fallbackJson: { maxDepth: 2 } }, two) });
    const result = await svc.getEffective(TENANT, 'harness.judge', { explicitProvider: 'azure' });
    expect(result.fallbackChain).toEqual([]);
    expect(result.rejectedCandidates).toEqual([
      expect.objectContaining({ connectionRef: 'bedrock', reason: RoutingHopRejection.ExplicitProviderStrict }),
    ]);
  });

  it('opens the chain under STRICT_UNLESS_OPTED_IN only when the request opts in', async () => {
    const shared = { tenantId: TENANT, fallbackJson: { maxDepth: 2 }, explicitProviderMode: AiExplicitProviderMode.STRICT_UNLESS_OPTED_IN };
    const closed = await makeService({ rows: makeChain(shared, two) }).svc.getEffective(TENANT, 'harness.judge', { explicitProvider: 'azure' });
    expect(closed.fallbackChain).toEqual([]);

    const opened = await makeService({ rows: makeChain(shared, two) }).svc.getEffective(TENANT, 'harness.judge', {
      explicitProvider: 'azure',
      allowFallbacks: true,
    });
    expect(opened.fallbackChain.map((c) => c.connectionRef)).toEqual(['bedrock']);
  });

  it('opting in still cannot cross a hard gate', async () => {
    const rows = makeChain({ tenantId: TENANT, fallbackJson: { maxDepth: 2 }, explicitProviderMode: AiExplicitProviderMode.STRICT_UNLESS_OPTED_IN }, [
      { connectionRef: 'azure' },
      { connectionRef: 'bedrock', residency: 'AWS_EU' },
    ]);
    const result = await makeService({ rows }).svc.getEffective(TENANT, 'harness.judge', { explicitProvider: 'azure', allowFallbacks: true });
    expect(result.fallbackChain).toEqual([]);
    expect(result.rejectedCandidates).toEqual([
      expect.objectContaining({ connectionRef: 'bedrock', reason: RoutingHopRejection.ResidencyClassMismatch }),
    ]);
  });

  it('reports provider_not_in_policy for a provider no configuration lists', async () => {
    const { svc } = makeService({ rows: makeChain({ tenantId: TENANT }, two) });
    const result = await svc.getEffective(TENANT, 'harness.judge', { explicitProvider: 'never-heard-of-it' });
    expect(result.rejection?.code).toBe('provider_not_in_policy');
  });
});

describe('setDefault — the ELECTION is atomic ', () => {
  it('unsets the incumbent and sets the successor INSIDE ONE transaction', async () => {
    // The invariant that matters: a fail-closed selection must never be
    // observable with no default. Two writes could leave that window open; one
    // transaction cannot.
    const row = makeConfig({ tenantId: TENANT, isDefault: false });
    const { svc, repo, unitOfWork, tx } = makeService({ rows: [row] });

    await svc.setDefault(row.id, TENANT, row.version);

    expect(unitOfWork.runInTransaction).toHaveBeenCalledTimes(1);
    expect(repo.clearDefaultFor).toHaveBeenCalledWith(TENANT, 'harness.judge', row.id, tx, 'u1');
    expect(repo.updateWithVersion).toHaveBeenCalledWith(row.id, row, row.version, tx);
    // Order is load-bearing: clearing AFTER setting would put two rows at
    // `isDefault = true` at the moment the partial unique index is checked.
    const clearOrder = repo.clearDefaultFor.mock.invocationCallOrder[0];
    const setOrder = repo.updateWithVersion.mock.invocationCallOrder[0];
    expect(clearOrder).toBeLessThan(setOrder);
  });

  it('is idempotent — re-electing the current default writes nothing', async () => {
    const row = makeConfig({ tenantId: TENANT, isDefault: true });
    const { svc, repo } = makeService({ rows: [row] });
    const result = await svc.setDefault(row.id, TENANT, row.version);
    expect(result.id).toBe(row.id);
    // No version bump for a no-op — an administrative assertion, not a toggle.
    expect(repo.updateWithVersion).not.toHaveBeenCalled();
  });

  it('broadcasts ResourceUpdated naming how many rows were unseated', async () => {
    const row = makeConfig({ tenantId: TENANT, isDefault: false });
    const { svc, emitter } = makeService({ rows: [row] });
    await svc.setDefault(row.id, TENANT, row.version);
    const [type, payload] = emitter.emit.mock.calls[0];
    expect(type).toBe(SysEventType.ResourceUpdated);
    expect(payload.data.reason).toBe('default_elected');
    expect(payload.data.unseatedCount).toBe(1);
  });

  it('refuses to elect a DISABLED candidate', async () => {
    // Electing a row the resolver then skips is a default that defaults to
    // nothing — it must look misconfigured, not configured.
    const row = makeConfig({ tenantId: TENANT, enabled: false });
    const { svc } = makeService({ rows: [row] });
    await expect(svc.setDefault(row.id, TENANT, row.version)).rejects.toBeInstanceOf(BadRequestException);
  });

  it('requires super admin (403) and answers 404 for another tenant row', async () => {
    const forbidden = makeService({ roles: ['TENANT_ADMIN'], rows: [] });
    await expect(forbidden.svc.setDefault('p1', TENANT)).rejects.toBeInstanceOf(ForbiddenException);

    const foreign = makeService({ rows: [makeConfig({ tenantId: OTHER_TENANT })] });
    await expect(foreign.svc.setDefault('p1', TENANT)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('promote — a configuration crosses tenants, a credential never does ', () => {
  it('copies the binding but NOT the source connection, and lands NOT elected', async () => {
    const source = makeConfig({ tenantId: OTHER_TENANT, connectionRef: 'azure', model: 'gpt-4o', isDefault: true });
    const { svc, repo, connections, db } = makeService({ rows: [source] });
    // Reading a row owned by a tenant OUTSIDE [caller, SYSTEM] runs on the
    // unscoped base client — the super-admin cross-tenant READ lane.
    db.baseClient.aiRoutingPolicy.findMany.mockResolvedValue([source]);

    const promoted = await svc.promote(source.id, OTHER_TENANT, TENANT);

    // The TARGET tenant's own connection is looked up for the same
    // (service, provider) — the source row's id is never carried across.
    expect(connections.findDefaultRow).toHaveBeenCalledWith('llm', 'azure', TENANT);
    const created = repo.create.mock.calls[0][0];
    expect(created.tenantId).toBe(TENANT);
    expect(created.modelId).toBe('model:gpt-4o');
    // Promotion offers a configuration; it does not switch a tenant's traffic.
    expect(created.isDefault).toBe(false);
    expect(promoted.status).toBe(AiRoutingPolicyStatus.DRAFT);
  });

  it('lands with NO connection when the target tenant has none for that provider', async () => {
    const source = makeConfig({ tenantId: OTHER_TENANT, connectionRef: 'azure' });
    const { svc, repo, connections, db } = makeService({ rows: [source] });
    db.baseClient.aiRoutingPolicy.findMany.mockResolvedValue([source]);
    connections.findDefaultRow.mockResolvedValueOnce(null);
    await svc.promote(source.id, OTHER_TENANT, TENANT);
    // Fail-closed: the operator must supply a credential, and the row never
    // silently inherits the source tenant's key or billing.
    expect(repo.create.mock.calls[0][0].providerConnectionId).toBeNull();
  });

  it('records credentialCopied:false on the audit event', async () => {
    const source = makeConfig({ tenantId: OTHER_TENANT });
    const { svc, emitter, db } = makeService({ rows: [source] });
    db.baseClient.aiRoutingPolicy.findMany.mockResolvedValue([source]);
    await svc.promote(source.id, OTHER_TENANT, TENANT);
    expect(emitter.emit.mock.calls[0][1].data).toMatchObject({ reason: 'promoted', credentialCopied: false });
  });

  it('re-points at the target tenant’s DEFAULT connection, never a named sibling (TASK-958 D-11)', async () => {
    const source = makeConfig({ tenantId: OTHER_TENANT, connectionRef: 'azure', model: 'gpt-4o' });
    const { svc, repo, connections, db } = makeService({ rows: [source] });
    db.baseClient.aiRoutingPolicy.findMany.mockResolvedValue([source]);
    connections.findDefaultRow.mockResolvedValue({ id: 'conn:azure-default' });

    await svc.promote(source.id, OTHER_TENANT, TENANT);

    // A provider now names a GROUP of the target's connections and only one of
    // them is the row its provider-name cascade resolves. Landing on a sibling
    // would hand the target a configuration pointing at an account it never
    // elected, so the by-slug lookup must NOT be the one used here.
    expect(connections.findDefaultRow).toHaveBeenCalledWith('llm', 'azure', TENANT);
    expect(connections.findRow).not.toHaveBeenCalled();
    expect(repo.create.mock.calls[0][0].providerConnectionId).toBe('conn:azure-default');
  });

  it('refuses to promote a configuration onto its own tenant', async () => {
    const { svc } = makeService({ rows: [makeConfig({ tenantId: TENANT })] });
    await expect(svc.promote('p1', TENANT, TENANT)).rejects.toBeInstanceOf(ArgumentInvalidException);
  });
});

describe('export / import — no secret is recoverable from the artifact ', () => {
  it('emits a credentialRef LOCATOR and no key material whatsoever', async () => {
    const { svc } = makeService({ rows: [makeConfig({ tenantId: TENANT, connectionRef: 'azure', model: 'gpt-4o', isDefault: true })] });
    const artifact = await svc.exportConfigurations(TENANT);

    expect(artifact.secretsIncluded).toBe(false);
    const [config] = artifact.configurations;
    expect(config.hasCredential).toBe(true);
    // The locator names WHICH credential, built only from non-secret identity:
    // capability, provider name and the platform-assigned key VERSION.
    expect(config.credentialRef).toBe('vault-transit:llm:azure:v3');
    expect(config).not.toHaveProperty('encryptedApiKey');
  });

  it('carries no ciphertext ANYWHERE in the serialized artifact', async () => {
    // The real assertion: serialize the whole thing and prove the connection's
    // key bytes are absent. `encryptedApiKey` in the mock is [1,2,3]; a leak
    // through any nesting would show up as those bytes.
    const { svc } = makeService({ rows: [makeConfig({ tenantId: TENANT, isDefault: true })] });
    const artifact = await svc.exportConfigurations(TENANT);
    const serialized = JSON.stringify(artifact);

    expect(serialized).not.toContain('encryptedApiKey');
    expect(serialized).not.toContain('"0":1');
    expect(() => assertNoSecretMaterial(artifact)).not.toThrow();
  });

  it('the structural guard REJECTS an artifact that gained a secret field', async () => {
    // Proves the guard is real rather than vacuously passing: the check is what
    // catches a future field added in a hurry, which a review of the builder
    // would not.
    const { svc } = makeService({ rows: [makeConfig({ tenantId: TENANT, isDefault: true })] });
    const artifact: any = await svc.exportConfigurations(TENANT);
    artifact.configurations[0].encryptedApiKey = 'AAECAw==';
    expect(() => assertNoSecretMaterial(artifact)).toThrow(/forbidden key/i);
  });

  it('also rejects raw binary smuggled at any depth', async () => {
    const artifact: any = { formatVersion: 1, configurations: [{ nested: { blob: new Uint8Array([1, 2, 3]) } }] };
    expect(() => assertNoSecretMaterial(artifact)).toThrow(/binary data/i);
  });

  it('reports NO credential requirement for a configuration served by no connection', async () => {
    const { svc } = makeService({ rows: [makeConfig({ tenantId: TENANT, connectionRef: null, model: 'medical-ner', isDefault: true })] });
    const [config] = (await svc.exportConfigurations(TENANT)).configurations;
    expect(config.hasCredential).toBe(false);
    expect(config.credentialRef).toBeNull();
  });

  it('import lands rows NOT elected and tells the operator which secrets to supply', async () => {
    const { svc, repo, connections } = makeService({ rows: [] });
    connections.findRow.mockResolvedValue(null);

    const result = await svc.importConfigurations(TENANT, {
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      sourceTenantId: OTHER_TENANT,
      secretsIncluded: false,
      notice: 'x',
      configurations: [
        {
          taskKey: 'harness.judge',
          taskKind: null,
          displayName: 'Azure GPT-4o',
          connection: { service: 'llm', provider: 'azure' },
          modelSlug: 'gpt-4o',
          modelRef: null,
          isDefault: true,
          enabled: true,
          residency: 'AZURE_EU',
          baaCovered: true,
          priority: 0,
          credentialRef: 'vault-transit:llm:azure:v3',
          hasCredential: true,
        },
      ],
    });

    expect(result.imported).toBe(1);
    // An import can never restore a key, so it says so rather than letting the
    // gap surface later as a 503.
    expect(result.requiresCredential).toEqual(['vault-transit:llm:azure:v3']);
    const created = repo.create.mock.calls[0][0];
    // `isDefault: true` in the ARTIFACT must not unseat the target tenant's own
    // elected default — an import describes configurations, it does not
    // authorise a traffic switch.
    expect(created.isDefault).toBe(false);
    expect(created.status).toBe(AiRoutingPolicyStatus.DRAFT);
  });

  it('SKIPS an entry whose model slug resolves to nothing rather than guessing', async () => {
    const { svc, models, repo } = makeService({ rows: [] });
    models.findBySlug.mockResolvedValue(null);
    const result = await svc.importConfigurations(TENANT, {
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      sourceTenantId: OTHER_TENANT,
      secretsIncluded: false,
      notice: 'x',
      configurations: [
        {
          taskKey: 'harness.judge',
          taskKind: null,
          displayName: null,
          connection: null,
          modelSlug: 'a-model-this-tenant-does-not-have',
          modelRef: null,
          isDefault: false,
          enabled: true,
          residency: null,
          baaCovered: null,
          priority: 0,
          credentialRef: null,
          hasCredential: false,
        },
      ],
    });
    expect(result.skipped).toBe(1);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('refuses an artifact of an unrecognised format', async () => {
    const { svc } = makeService({ rows: [] });
    await expect(svc.importConfigurations(TENANT, { formatVersion: 99 } as any)).rejects.toBeInstanceOf(ArgumentInvalidException);
  });

  it('export and import are super-admin only', async () => {
    const { svc } = makeService({ roles: ['TENANT_ADMIN'], rows: [] });
    await expect(svc.exportConfigurations(TENANT)).rejects.toBeInstanceOf(ForbiddenException);
    await expect(svc.importConfigurations(TENANT, { formatVersion: 1, configurations: [] } as any)).rejects.toBeInstanceOf(ForbiddenException);
  });
});

describe('writes — super admin only (403), cross-tenant id (404)', () => {
  const dto = { taskKey: 'harness.judge', modelId: 'model:gpt-4o' };

  it.each([
    ['create', (s: AiRoutingPolicyService) => s.create(TENANT, dto as any)],
    ['update', (s: AiRoutingPolicyService) => s.update('p1', TENANT, { killSwitch: true, expectedVersion: 1 })],
    ['activate', (s: AiRoutingPolicyService) => s.activate('p1', TENANT, 1)],
    ['deleteById', (s: AiRoutingPolicyService) => s.deleteById('p1', TENANT)],
    ['list', (s: AiRoutingPolicyService) => s.list(TENANT)],
    ['getById', (s: AiRoutingPolicyService) => s.getById('p1', TENANT)],
    ['setDefault', (s: AiRoutingPolicyService) => s.setDefault('p1', TENANT)],
    ['promote', (s: AiRoutingPolicyService) => s.promote('p1', OTHER_TENANT, TENANT)],
  ])('%s throws ForbiddenException for a non-super-admin — a PRIVILEGE rule, so 403 not 404', async (_name, call) => {
    const { svc } = makeService({ roles: ['TENANT_ADMIN'], rows: [] });
    await expect(call(svc)).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('answers 404 — never 403 — for a configuration owned by another tenant', async () => {
    // 404-over-403: a privilege message would confirm the id exists somewhere.
    const { svc } = makeService({ rows: [makeConfig({ tenantId: OTHER_TENANT })] });
    await expect(svc.getById('p1', TENANT)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('answers 404 when no row exists at all — the same answer, so absence is indistinguishable', async () => {
    const { svc } = makeService({ rows: [] });
    await expect(svc.getById('p1', TENANT)).rejects.toBeInstanceOf(NotFoundException);
  });
});

describe('create', () => {
  const body = { taskKey: 'harness.judge', modelId: 'model:gpt-4o', providerConnectionId: 'conn:azure' };

  it('builds the entity through the FACTORY and persists it as a DRAFT', async () => {
    const spy = vi.spyOn(AiRoutingPolicyFactory, 'CreateAiRoutingPolicy');
    const { svc, repo } = makeService({ rows: [] });
    const saved = await svc.create(TENANT, body as any);
    expect(spy).toHaveBeenCalledTimes(1);
    expect(repo.create).toHaveBeenCalledTimes(1);
    expect(saved.status).toBe(AiRoutingPolicyStatus.DRAFT);
    expect(saved.policyVersion).toBe(1);
    spy.mockRestore();
  });

  it('DERIVES taskKind from taskKey rather than accepting one', async () => {
    // Two axes that must not drift: a caller asserting a kind that disagrees
    // with its own task key is how they come apart.
    const { svc, repo } = makeService({ rows: [] });
    await svc.create(TENANT, body as any);
    expect(repo.create.mock.calls[0][0].taskKind).toBe('TEXT_GENERATION');
  });

  it('never elects on create — election is its own audited transition', async () => {
    const { svc, repo } = makeService({ rows: [] });
    await svc.create(TENANT, { ...body, isDefault: true } as any);
    expect(repo.create.mock.calls[0][0].isDefault).toBe(false);
  });

  it('takes the next authored revision after the highest existing one', async () => {
    const { svc } = makeService({ rows: [makeConfig({ tenantId: TENANT, policyVersion: 7 })] });
    const saved = await svc.create(TENANT, body as any);
    expect(saved.policyVersion).toBe(8);
  });

  it('broadcasts ResourceCreated with a before/after audit pair', async () => {
    const { svc, emitter } = makeService({ rows: [] });
    await svc.create(TENANT, body as any);
    const [type, payload] = emitter.emit.mock.calls[0];
    expect(type).toBe(SysEventType.ResourceCreated);
    expect(payload.data.before).toBeNull();
    expect(payload.data.after).toMatchObject({ taskKey: 'harness.judge', status: AiRoutingPolicyStatus.DRAFT });
  });

  it('refuses a configuration that names no model at all', async () => {
    const { svc } = makeService({ rows: [] });
    await expect(svc.create(TENANT, { taskKey: 'harness.judge' } as any)).rejects.toBeInstanceOf(ArgumentInvalidException);
  });

  it('still refuses a legacy candidate list where nothing survives parsing', async () => {
    const { svc } = makeService({ rows: [] });
    // `baaCovered` missing — the BAA gate reads it, so it is never defaulted.
    await expect(
      svc.create(TENANT, { taskKey: 'harness.judge', candidates: [{ connectionRef: 'azure', model: 'gpt-4o', residency: 'AZURE_US' }] } as any),
    ).rejects.toBeInstanceOf(ArgumentInvalidException);
  });

  it('refuses a revision number that already exists for this (tenant, task)', async () => {
    const { svc } = makeService({ rows: [makeConfig({ tenantId: TENANT, policyVersion: 3 })] });
    await expect(svc.create(TENANT, { ...body, policyVersion: 3 } as any)).rejects.toBeInstanceOf(ArgumentInvalidException);
  });
});

describe('write-time task compatibility — a routing row cannot bind a model that cannot serve its task', () => {
  // TASK-881 retired the `AiTaskDefault` facade, and with it the ONE write-time
  // check the routing service never had: `upsertRow` refused a slug whose
  // registry row declared a different `taskType`. Without it a super admin can
  // elect, say, a TOKEN_CLASSIFICATION span extractor as the `harness.judge`
  // default, and the failure surfaces at inference time as an unusable model
  // rather than at write time as a rejected request.
  const body = { taskKey: 'harness.judge', modelId: 'model:gpt-4o', providerConnectionId: 'conn:azure' };

  it('accepts a model whose taskType serves the task key', async () => {
    const { svc, repo } = makeService({ rows: [], modelTaskType: 'TEXT_GENERATION' });
    await svc.create(TENANT, body as any);
    expect(repo.create).toHaveBeenCalledTimes(1);
  });

  it('rejects 409 with a named code when the model cannot serve the task', async () => {
    const { svc, repo } = makeService({ rows: [], modelTaskType: 'TOKEN_CLASSIFICATION' });
    await expect(svc.create(TENANT, body as any)).rejects.toMatchObject({
      status: 409,
      response: { code: 'ROUTING_MODEL_TASK_MISMATCH' },
    });
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('admits either shape where the task legitimately has two — content safety is served by a text OR a token classifier', async () => {
    for (const taskType of ['TEXT_CLASSIFICATION', 'TOKEN_CLASSIFICATION']) {
      const { svc, repo } = makeService({ rows: [], modelTaskType: taskType });
      await svc.create(TENANT, { ...body, taskKey: 'guardrail.safety' } as any);
      expect(repo.create).toHaveBeenCalledTimes(1);
    }
  });

  it('answers 404 — never 403 — for a model owned by another tenant', async () => {
    // The cross-tenant posture: a foreign id and an id that does not exist give
    // the same answer, so the write surface is not an existence oracle over the
    // catalogue.
    const { svc, repo } = makeService({ rows: [], modelTenantId: OTHER_TENANT });
    await expect(svc.create(TENANT, body as any)).rejects.toBeInstanceOf(NotFoundException);
    expect(repo.create).not.toHaveBeenCalled();
  });

  it('answers 404 for a model id that resolves to nothing at all — the same answer', async () => {
    const { svc, models } = makeService({ rows: [] });
    models.findByIdOrNull.mockResolvedValueOnce(null);
    await expect(svc.create(TENANT, body as any)).rejects.toBeInstanceOf(NotFoundException);
  });

  it("accepts the tenant's OWN catalogue row, not just the platform one", async () => {
    const { svc, repo } = makeService({ rows: [], modelTenantId: TENANT });
    await svc.create(TENANT, body as any);
    expect(repo.create).toHaveBeenCalledTimes(1);
  });

  it('checks nothing when the configuration names a provider-side modelRef instead of a catalogue FK', async () => {
    // `modelRef` is a provider-native id for a model the catalogue does not
    // carry, so there is no `taskType` to compare against. Refusing it here
    // would forbid the very case the field exists for.
    const { svc, models, repo } = makeService({ rows: [] });
    await svc.create(TENANT, { taskKey: 'harness.judge', modelRef: 'my-azure-deployment' } as any);
    expect(models.findByIdOrNull).not.toHaveBeenCalled();
    expect(repo.create).toHaveBeenCalledTimes(1);
  });

  it('applies on UPDATE too — a DRAFT may be re-bound, but not onto a model that cannot serve it', async () => {
    const draft = makeConfig({ tenantId: TENANT, status: AiRoutingPolicyStatus.DRAFT, taskKey: 'harness.judge' });
    const { svc, repo } = makeService({ rows: [draft], modelTaskType: 'TOKEN_CLASSIFICATION' });
    await expect(svc.update(draft.id, TENANT, { modelId: 'model:medical-ner', expectedVersion: draft.version } as any)).rejects.toMatchObject({
      status: 409,
      response: { code: 'ROUTING_MODEL_TASK_MISMATCH' },
    });
    expect(repo.updateWithVersion).not.toHaveBeenCalled();
  });

  it('leaves an update that does not touch the binding alone', async () => {
    const draft = makeConfig({ tenantId: TENANT, status: AiRoutingPolicyStatus.DRAFT, taskKey: 'harness.judge' });
    const { svc, models } = makeService({ rows: [draft], modelTaskType: 'TOKEN_CLASSIFICATION' });
    await svc.update(draft.id, TENANT, { priority: 5, expectedVersion: draft.version });
    expect(models.findByIdOrNull).not.toHaveBeenCalled();
  });
});

describe('update — a served revision is a rollback target, not a scratchpad', () => {
  it('allows a full edit on a DRAFT', async () => {
    const draft = makeConfig({ tenantId: TENANT, status: AiRoutingPolicyStatus.DRAFT });
    const { svc, repo, emitter } = makeService({ rows: [draft] });
    await svc.update(draft.id, TENANT, { priority: 5, expectedVersion: draft.version });
    expect(repo.updateWithVersion).toHaveBeenCalledTimes(1);
    expect(emitter.emit.mock.calls[0][0]).toBe(SysEventType.ResourceUpdated);
  });

  it('REFUSES a routing-semantics edit on an ACTIVE revision', async () => {
    const active = makeConfig({ tenantId: TENANT, status: AiRoutingPolicyStatus.ACTIVE });
    const { svc } = makeService({ rows: [active] });
    await expect(svc.update(active.id, TENANT, { priority: 5, expectedVersion: active.version })).rejects.toBeInstanceOf(BadRequestException);
  });

  it('REFUSES a binding change on an ACTIVE revision — it redirects PHI to another vendor', async () => {
    const active = makeConfig({ tenantId: TENANT, status: AiRoutingPolicyStatus.ACTIVE });
    const { svc } = makeService({ rows: [active] });
    await expect(svc.update(active.id, TENANT, { modelId: 'model:something-else', expectedVersion: active.version } as any)).rejects.toBeInstanceOf(
      BadRequestException,
    );
  });

  it('still allows the kill switch to be flipped on an ACTIVE revision', async () => {
    const active = makeConfig({ tenantId: TENANT, status: AiRoutingPolicyStatus.ACTIVE });
    const { svc, repo } = makeService({ rows: [active] });
    await svc.update(active.id, TENANT, { killSwitch: true, expectedVersion: active.version });
    expect(repo.updateWithVersion).toHaveBeenCalledTimes(1);
  });

  it('carries before/after on the audit event', async () => {
    const draft = makeConfig({ tenantId: TENANT, status: AiRoutingPolicyStatus.DRAFT, priority: 0 });
    const { svc, emitter } = makeService({ rows: [draft] });
    await svc.update(draft.id, TENANT, { priority: 9, expectedVersion: draft.version });
    const payload = emitter.emit.mock.calls[0][1];
    expect(payload.data.before.priority).toBe(0);
    expect(payload.data.after.priority).toBe(9);
  });
});

describe('activate — supersede-only promotion', () => {
  it('promotes the DRAFT, archives its predecessor and records the lineage', async () => {
    const draft = makeConfig({ tenantId: TENANT, status: AiRoutingPolicyStatus.DRAFT, policyVersion: 2 });
    const previous = makeConfig({ tenantId: TENANT, status: AiRoutingPolicyStatus.ACTIVE, policyVersion: 1 });
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
    const active = makeConfig({ tenantId: TENANT, status: AiRoutingPolicyStatus.ACTIVE });
    const { svc } = makeService({ rows: [active] });
    await expect(svc.activate(active.id, TENANT, active.version)).rejects.toBeInstanceOf(ArgumentInvalidException);
  });
});

describe('deleteById', () => {
  it('soft-deletes and broadcasts ResourceDeleted', async () => {
    const row = makeConfig({ tenantId: TENANT });
    const { svc, repo, emitter } = makeService({ rows: [row] });
    await svc.deleteById(row.id, TENANT);
    expect(repo.softDelete).toHaveBeenCalledWith(row.id, 'u1', undefined);
    expect(emitter.emit.mock.calls[0][0]).toBe(SysEventType.ResourceDeleted);
  });
});
