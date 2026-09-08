/**
 * TASK-885 (owner #4) — `syncToTenants` and `promoteToSystem`.
 *
 * The two cross-tenant verbs this lane adds, and the boundary each one enforces:
 *
 * | Verb | Who | Refusal |
 * |---|---|---|
 * | `syncToTenants` | a multi-tenant admin, over tenants they ALREADY manage | a target they do not manage is a **404** — never a 403, so the route can never enumerate the deployment's tenants |
 * | `promoteToSystem` | the platform admin only | **403** — a privilege boundary (`05-nestjs-api.md` §Imperative Privilege Checks), not the 404-over-403 cross-tenant posture |
 *
 * `promoteToSystem` runs under an ELEVATED TENANT-LESS context for the mechanical reason
 * `AgentPromotionService` documents: with a pinned tenant the tenant-scope Prisma extension
 * forces the caller's `tenantId` into every read, which makes a cross-tenant read impossible
 * rather than merely unauthorized. `syncToTenants` did too, until TASK-889 — which is why the
 * customer admin owner #4 names could not reach it. It now NAMES the tenant of each step
 * instead (`runInTenantContext`), so every read and write is fully scoped and no elevation is
 * involved; see `agentPromotion/__tests__/membership-bounded-sync.task889.test.ts`.
 *
 * Written RED-first: every test in this file failed against `4db808607`, where `syncToTenants`
 * and `promoteToSystem` did not exist.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { SYSTEM_TENANT_ID, WorkflowDefinitionStatus } from '@arcaai/domains';
import { WorkflowDefinitionService } from '../workflow-definition.service';

const GLOBAL = '50000000-0000-0000-0000-000000000000';

const mockClsService = {
  get: vi.fn(),
  set: vi.fn(),
  // TASK-889 — a sync runs each cross-tenant step under its OWN CLS store
  // (`runInTenantContext`). This fixture pins one tenant through `get`, so `run` only has to
  // invoke the step; that the step's tenant is the right one is proven against the REAL
  // tenant-scope extension in `agentPromotion/__tests__/membership-bounded-sync.task889.test.ts`.
  run: vi.fn((optionsOrCallback: unknown, maybeCallback?: unknown) =>
    (typeof optionsOrCallback === 'function' ? optionsOrCallback : (maybeCallback as () => unknown))(),
  ),
};
const mockEventEmitter = { emit: vi.fn() };

const mockRepository = {
  findById: vi.fn(),
  count: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  findMaxVersionNumber: vi.fn(),
  findPublishedBySlug: vi.fn(),
  findAllVersionsBySlug: vi.fn(),
};

const mockDatabaseService = { baseClient: { $transaction: vi.fn((cb: (tx: unknown) => unknown) => cb({})) } };
const mockEntitlements = {
  isEnforcementEnabled: vi.fn(() => false),
  assertQuantityQuota: vi.fn(),
  isFeatureEnabled: vi.fn(() => Promise.resolve(true)),
};
const mockPromptTemplateRepository = { findById: vi.fn(), findByName: vi.fn() };
const mockAgentPromotion = { promote: vi.fn() };
const mockEvalGate = { evaluateWorkflowPromotion: vi.fn() };
const mockPolicyEngine = { buildAbility: vi.fn() };

/** TASK-893 — the only vocabulary left is `core`; `noop` and the `summarization` palette are gone. */
const PLAIN_GRAPH = {
  version: 1,
  nodes: [
    { id: 't1', type: 'core.trigger', config: { kinds: ['api'] }, position: { x: 0, y: 0 } },
    { id: 'a1', type: 'core.agent', config: { agentRef: { slug: 'summarizer' } }, position: { x: 1, y: 0 } },
    { id: 'o1', type: 'core.output', config: { protocols: ['http'] }, position: { x: 2, y: 0 } },
  ],
  edges: [
    { id: 'e1', from: 't1', to: 'a1', fromPort: 'out', toPort: 'context' },
    { id: 'e2', from: 'a1', to: 'o1', fromPort: 'out', toPort: 'in' },
  ],
};

const entity = (overrides: Record<string, unknown> = {}) => ({
  id: 'def-1',
  tenantId: 'tenant-a',
  slug: 'soap',
  name: 'SOAP',
  description: null,
  paletteKey: 'core',
  versionNumber: 2,
  parentVersionId: null,
  status: WorkflowDefinitionStatus.PUBLISHED,
  graph: PLAIN_GRAPH,
  graphChecksum: 'c1',
  compiledConfig: null,
  compiledConfigChecksum: null,
  registryChecksum: null,
  validationReport: null,
  needsReview: false,
  validatedAt: null,
  publishedAt: new Date('2026-09-01T00:00:00Z'),
  deprecatedAt: null,
  isActive: true,
  resourceStatus: 'ENABLED',
  createdAt: new Date('2026-09-01T00:00:00Z'),
  updatedAt: new Date('2026-09-01T00:00:00Z'),
  version: 1,
  tags: [],
  hasChanges: false,
  changes: {},
  ...overrides,
});

const construct = () =>
  new WorkflowDefinitionService(
    mockRepository as never,
    mockEventEmitter as never,
    mockClsService as never,
    mockDatabaseService as never,
    mockEntitlements as never,
    undefined,
    undefined,
    mockPromptTemplateRepository as never,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    mockAgentPromotion as never,
    mockEvalGate as never,
    mockPolicyEngine as never,
  );

/** A tenant-less SUPER_ADMIN — the elevated context both verbs require. */
function elevated() {
  mockClsService.get.mockImplementation((key: string) => {
    if (key === 'tenantId') return undefined;
    if (key === 'user') return { id: 'root-1', roles: ['SUPER_ADMIN'] };
    return undefined;
  });
}

describe('WorkflowDefinitionService — sync among own tenants (TASK-885)', () => {
  let service: WorkflowDefinitionService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEntitlements.isEnforcementEnabled.mockReturnValue(false);
    mockDatabaseService.baseClient.$transaction.mockImplementation((cb: (tx: unknown) => unknown) => cb({}));
    mockRepository.findMaxVersionNumber.mockResolvedValue(0);
    mockRepository.create.mockImplementation((created: unknown) => Promise.resolve(created));
    mockRepository.findPublishedBySlug.mockResolvedValue(entity());
    mockPolicyEngine.buildAbility.mockResolvedValue({ can: () => true });
    elevated();
    service = construct();
  });

  it('writes a DRAFT into every managed target, recompiled against THAT tenant', async () => {
    const result = await service.syncToTenants('soap', { sourceTenantId: 'tenant-a', targetTenantIds: ['tenant-b', 'tenant-c'] });

    expect(mockRepository.create).toHaveBeenCalledTimes(2);
    const written = mockRepository.create.mock.calls.map((call) => call[0]);
    expect(written.map((row) => row.tenantId)).toEqual(['tenant-b', 'tenant-c']);
    for (const row of written) {
      expect(row.slug).toBe('soap');
      expect(row.status).toBe(WorkflowDefinitionStatus.DRAFT);
      expect(row.isActive).toBe(false);
      expect(row.compiledConfig).toBeNull();
      // Recomputed for the TARGET, never carried from the source row.
      expect(row.validationReport).toBeDefined();
    }
    expect(result.targets.map((target) => target.tenantId)).toEqual(['tenant-b', 'tenant-c']);
    expect(result.sourceVersionNumber).toBe(2);
  });

  it('mints the NEXT version when the target already has the lineage — a sync is a new version, not a new workflow', async () => {
    mockRepository.findMaxVersionNumber.mockResolvedValue(4);

    const result = await service.syncToTenants('soap', { sourceTenantId: 'tenant-a', targetTenantIds: ['tenant-b'] });

    expect(mockRepository.create.mock.calls[0][0].versionNumber).toBe(5);
    expect(result.targets[0].versionNumber).toBe(5);
  });

  it('is a 404 for a target the caller does NOT manage — never a 403, which would confirm the tenant exists', async () => {
    mockPolicyEngine.buildAbility.mockImplementation(({ tenantId }: { tenantId: string }) => Promise.resolve({ can: () => tenantId !== 'tenant-x' }));

    await expect(service.syncToTenants('soap', { sourceTenantId: 'tenant-a', targetTenantIds: ['tenant-b', 'tenant-x'] })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(mockRepository.create).not.toHaveBeenCalled();
  });

  it('is a 403 when the caller does not manage the SOURCE — a privilege they claimed, not a tenant they probed', async () => {
    mockPolicyEngine.buildAbility.mockImplementation(({ tenantId }: { tenantId: string }) => Promise.resolve({ can: () => tenantId !== 'tenant-a' }));

    await expect(service.syncToTenants('soap', { sourceTenantId: 'tenant-a', targetTenantIds: ['tenant-b'] })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
  });

  it('refuses to sync into the source tenant itself', async () => {
    await expect(service.syncToTenants('soap', { sourceTenantId: 'tenant-a', targetTenantIds: ['tenant-a'] })).rejects.toThrow();
  });

  it('refuses the WHOLE sync, naming the tenant, when a target cannot resolve a reference — never a partial estate', async () => {
    mockRepository.findPublishedBySlug.mockResolvedValue(
      entity({ graph: { version: 1, nodes: [{ id: 'n1', type: 'noop', config: { promptTemplateId: 'tpl-1' } }], edges: [] } }),
    );
    mockPromptTemplateRepository.findById.mockResolvedValue({ id: 'tpl-1', name: 'SOAP Prompt' });
    mockPromptTemplateRepository.findByName.mockImplementation((tenantId: string) =>
      Promise.resolve(tenantId === 'tenant-b' ? { id: 'tpl-b' } : null),
    );

    const error = await service
      .syncToTenants('soap', { sourceTenantId: 'tenant-a', targetTenantIds: ['tenant-b', 'tenant-c'] })
      .catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ConflictException);
    const body = (error as ConflictException).getResponse() as { code: string; unresolved: { tenantId: string }[] };
    expect(body.code).toBe('WORKFLOW_SYNC_UNRESOLVED_REFERENCES');
    expect(body.unresolved.map((row) => row.tenantId)).toEqual(['tenant-c']);
    expect(mockRepository.create).not.toHaveBeenCalled();
  });

  // TASK-889 — REVERSED, deliberately. This used to assert that a sync requires the elevated
  // tenant-less context `promoteToSystem` requires, which locked out the person owner #4 names:
  // a multi-tenant CUSTOMER admin. A sync is now a sequence of ordinary per-tenant steps, each
  // named (`runInTenantContext`) and each separately authorised, so a pinned working tenant is
  // no longer a refusal. The elevated gate stays on `promoteToSystem`, tested below.
  it('lets a NON-elevated multi-tenant admin sync — a pinned working tenant is not a refusal', async () => {
    mockClsService.get.mockImplementation((key: string) => (key === 'tenantId' ? 'tenant-a' : { id: 'admin-1', roles: ['TENANT_ADMIN'] }));
    service = construct();

    const result = await service.syncToTenants('soap', { sourceTenantId: 'tenant-a', targetTenantIds: ['tenant-b'] });

    expect(result.targets.map((target) => target.tenantId)).toEqual(['tenant-b']);
    expect(mockRepository.create.mock.calls[0][0].tenantId).toBe('tenant-b');
  });
});

describe('WorkflowDefinitionService — Global -> SYSTEM promotion (TASK-885)', () => {
  let service: WorkflowDefinitionService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockEntitlements.isEnforcementEnabled.mockReturnValue(false);
    mockEntitlements.isFeatureEnabled.mockResolvedValue(true);
    mockDatabaseService.baseClient.$transaction.mockImplementation((cb: (tx: unknown) => unknown) => cb({}));
    // The GLOBAL source, and SYSTEM's previously-published template of the same slug.
    mockRepository.findPublishedBySlug.mockImplementation((tenantId: string) =>
      Promise.resolve(
        tenantId === GLOBAL ? entity({ tenantId: GLOBAL }) : entity({ id: 'sys-v1', tenantId: SYSTEM_TENANT_ID, versionNumber: 1, isActive: true }),
      ),
    );
    mockRepository.findById.mockResolvedValue(
      entity({ id: 'sys-draft-1', tenantId: SYSTEM_TENANT_ID, status: WorkflowDefinitionStatus.DRAFT, isActive: false }),
    );
    mockRepository.update.mockImplementation((_id: string, updated: unknown) => Promise.resolve(updated));
    mockRepository.findAllVersionsBySlug.mockResolvedValue([]);
    mockAgentPromotion.promote.mockResolvedValue({
      id: 'promo-1',
      targetDefinitionVersionId: 'sys-draft-1',
      targetDefinitionSlug: 'soap',
      warnings: [],
    });
    mockEvalGate.evaluateWorkflowPromotion.mockResolvedValue({
      mode: 'warn',
      evaluated: true,
      passed: true,
      blocked: false,
      failures: [],
      runIds: [],
      aggregates: {},
    });
    elevated();
    service = construct();
  });

  it('promotes Global -> SYSTEM through the existing promotion service and PUBLISHES the SYSTEM template', async () => {
    const result = await service.promoteToSystem({ sourceDefinitionSlug: 'soap' });

    expect(mockAgentPromotion.promote).toHaveBeenCalledWith(
      expect.objectContaining({ sourceDefinitionSlug: 'soap', fromTenantId: GLOBAL, toTenantId: SYSTEM_TENANT_ID }),
    );
    // The SYSTEM row is recompiled and published — it IS the platform template.
    const published = mockRepository.update.mock.calls.find((call) => call[0] === 'sys-draft-1')![1];
    expect(published.status).toBe(WorkflowDefinitionStatus.PUBLISHED);
    expect(published.isActive).toBe(true);
    expect(published.compiledConfig).toBeDefined();

    // The PRIOR SYSTEM version stays as HISTORY: demoted, never deleted, still PUBLISHED.
    const demoted = mockRepository.update.mock.calls.find((call) => call[0] === 'sys-v1')![1];
    expect(demoted.isActive).toBe(false);
    expect(demoted.status).toBe(WorkflowDefinitionStatus.PUBLISHED);
    expect(result.published).toBe(true);
    expect(result.promotionId).toBe('promo-1');
    expect(result.evalGateMode).toBe('warn');
  });

  it('is a 403 for a non-super-admin — only the platform admin manages SYSTEM', async () => {
    mockClsService.get.mockImplementation((key: string) => (key === 'tenantId' ? undefined : { id: 'admin-1', roles: ['TENANT_ADMIN'] }));
    service = construct();

    await expect(service.promoteToSystem({ sourceDefinitionSlug: 'soap' })).rejects.toBeInstanceOf(ForbiddenException);
    expect(mockAgentPromotion.promote).not.toHaveBeenCalled();
  });

  it('runs the eval gate on the GLOBAL source and passes its mode + warnings through', async () => {
    mockEvalGate.evaluateWorkflowPromotion.mockResolvedValue({
      mode: 'warn',
      evaluated: true,
      passed: false,
      blocked: false,
      failures: ['pdsqi_mean 3.1 < 4.0'],
      runIds: ['run-1'],
      aggregates: {},
    });

    const result = await service.promoteToSystem({ sourceDefinitionSlug: 'soap' });

    expect(mockEvalGate.evaluateWorkflowPromotion).toHaveBeenCalledWith(expect.objectContaining({ tenantId: GLOBAL, definitionSlug: 'soap' }));
    expect(result.published).toBe(true);
    expect(result.warnings).toContain('pdsqi_mean 3.1 < 4.0');
  });

  it('refuses with a 409 when the gate BLOCKS — nothing is promoted', async () => {
    mockEvalGate.evaluateWorkflowPromotion.mockResolvedValue({
      mode: 'block',
      evaluated: true,
      passed: false,
      blocked: true,
      failures: ['pdsqi_mean 3.1 < 4.0'],
      runIds: ['run-1'],
      aggregates: {},
    });

    const error = await service.promoteToSystem({ sourceDefinitionSlug: 'soap' }).catch((caught: unknown) => caught);

    expect(error).toBeInstanceOf(ConflictException);
    expect(((error as ConflictException).getResponse() as { code: string }).code).toBe('EVAL_GATE_FAILED');
    expect(mockAgentPromotion.promote).not.toHaveBeenCalled();
  });

  it('is a 404 when Global has no such published workflow', async () => {
    mockRepository.findPublishedBySlug.mockResolvedValue(null);

    await expect(service.promoteToSystem({ sourceDefinitionSlug: 'nope' })).rejects.toBeInstanceOf(NotFoundException);
  });
});
