/**
 * TASK-930 D-4 — `POST /admin/workflow-definitions/promote-to-system` was a closed loop that
 * failed DIRTY.
 *
 * ## What the local runtime gate found (§6.9, `local-runs-2026-09-08/EVIDENCE.md` §3b)
 *
 * With `X-Tenant-Id` the route answered 403 (`assertElevatedTenantlessContext`, which is correct
 * and deliberate); WITHOUT one it answered `400 "Tenant ID is required"` — so there was no way to
 * call it at all. Worse, that 400 arrived AFTER the promotion had committed:
 * `INSERT WorkflowDefinition → INSERT AgentPromotion → COMMIT → throw`, leaving an orphan SYSTEM
 * DRAFT `general-medicine-consultation` v2 behind on every attempt.
 *
 * ## The two defects, which are separate
 *
 * 1. **The publish ran with no tenant.** `promoteToSystem` promotes into SYSTEM from an elevated
 *    TENANT-LESS context, then calls `publishEntity`, whose reads are ordinary tenant-scoped ones:
 *    `resolveTriggerContextSchema` → `ConsultationContextSchemaService.resolveReference` →
 *    `requireTenantId()`. That is the throw site (NOT the two assignment services the evidence
 *    listed as candidates — neither is on this path). The promoted row lives in SYSTEM, so the
 *    publish must run under the SYSTEM tenant context, exactly as `cloneFromSystem` already runs
 *    its copy under the TARGET tenant's.
 * 2. **The publish ran after the commit.** Any publish failure — this one, a publish-gate
 *    refusal, a capability error — therefore littered SYSTEM with a DRAFT version and burned a
 *    version number. §6.2 wants a block to write nothing; that has to hold for the publish too.
 *
 * Written RED-first against `5b6b88f15`: test 1 observed `undefined` where it expects SYSTEM,
 * test 2 rejected with the 400, and test 3 found the publish had already been performed on a
 * committed row instead of being handed to the promotion's unit of work.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { BadRequestException } from '@nestjs/common';
import { SYSTEM_TENANT_ID, WorkflowDefinitionStatus } from '@arcaai/domains';
import { WorkflowDefinitionService } from '../workflow-definition.service';

const GLOBAL = '50000000-0000-0000-0000-000000000000';
/** `core.trigger`'s own config schema requires a UUID here — the publish gate checks that too. */
const SCHEMA_ID = '79000000-0000-0000-0001-000000000010';

/**
 * A CLS double that actually MODELS `runInTenantContext`: `set('tenantId')` mutates, `run`
 * inherits the current store and restores it on the way out. A `run` that merely invokes its
 * callback (the shape the sibling suites use) cannot tell "ran under SYSTEM" from "ran under
 * nothing", which is precisely the bug under test.
 */
let currentTenantId: string | undefined;
const mockClsService = {
  get: vi.fn((key: string) => {
    if (key === 'tenantId') return currentTenantId;
    if (key === 'user') return { id: 'root-1', roles: ['SUPER_ADMIN'] };
    return undefined;
  }),
  set: vi.fn((key: string, value: unknown) => {
    if (key === 'tenantId') currentTenantId = value as string | undefined;
  }),
  run: vi.fn(async (optionsOrCallback: unknown, maybeCallback?: unknown) => {
    const callback = (typeof optionsOrCallback === 'function' ? optionsOrCallback : maybeCallback) as () => unknown;
    const saved = currentTenantId;
    try {
      return await callback();
    } finally {
      currentTenantId = saved;
    }
  }),
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
const mockAgentRepository = { findPublishedActiveBySlug: vi.fn() };
const mockEvalGate = { evaluateWorkflowPromotion: vi.fn() };
const mockPolicyEngine = { buildAbility: vi.fn() };

/** Records the CLS tenant each publish-path read actually observed. */
const observedTenantIds: Array<string | undefined> = [];

/**
 * The production shape of the throw site, reduced to what this path exercises: BOTH reads
 * `publishEntity` makes require a tenant, and `resolveReference` is the one whose refusal is NOT
 * swallowed (`resolveContextSchemaVersionId` wraps `getEffectiveBundle` in `.catch(() => null)`).
 */
const mockContextSchemaService = {
  getEffectiveBundle: vi.fn(async () => {
    observedTenantIds.push(currentTenantId);
    if (!currentTenantId) throw new BadRequestException('Tenant ID is required');
    return { contextSchemaVersionId: 'ctx-version-1' };
  }),
  resolveReference: vi.fn(async () => {
    observedTenantIds.push(currentTenantId);
    if (!currentTenantId) throw new BadRequestException('Tenant ID is required');
    return {
      outcome: 'resolved' as const,
      schemaId: SCHEMA_ID,
      versionNumber: 1,
      versionId: 'ctx-version-1',
      payloadSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { intake: { type: 'object', properties: { severity: { type: 'string' } } } },
      },
    };
  }),
};

/**
 * `core.trigger` carries the context-schema REFERENCE, which is what makes `resolveReference`
 * run at all — the seeded `general-medicine-consultation` binds `consultation_note_context` the
 * same way, which is why the defect reproduced on it and on nothing else.
 */
const GRAPH = {
  version: 1,
  nodes: [
    {
      id: 't1',
      type: 'core.trigger',
      config: { kinds: ['api'], contextSchema: { contextSchemaId: SCHEMA_ID, versionNumber: 1 } },
      position: { x: 0, y: 0 },
    },
    { id: 'a1', type: 'core.agent', config: { agentRef: { slug: 'general-medicine-summarization' } }, position: { x: 1, y: 0 } },
    { id: 'o1', type: 'core.output', config: { protocols: ['http'] }, position: { x: 2, y: 0 } },
  ],
  edges: [
    { id: 'e1', from: 't1', to: 'a1', fromPort: 'out', toPort: 'context' },
    { id: 'e2', from: 'a1', to: 'o1', fromPort: 'out', toPort: 'in' },
  ],
};

const entity = (overrides: Record<string, unknown> = {}) => ({
  id: 'def-1',
  tenantId: GLOBAL,
  slug: 'general-medicine-consultation',
  name: 'General medicine consultation',
  description: null,
  paletteKey: 'core',
  versionNumber: 2,
  parentVersionId: null,
  status: WorkflowDefinitionStatus.PUBLISHED,
  graph: GRAPH,
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
  sourceTemplateSlug: null,
  templateLocked: false,
  resourceStatus: 'ENABLED',
  createdAt: new Date('2026-09-01T00:00:00Z'),
  updatedAt: new Date('2026-09-01T00:00:00Z'),
  version: 1,
  tags: [],
  hasChanges: false,
  changes: {},
  ...overrides,
});

const SYSTEM_DRAFT = () => entity({ id: 'sys-draft-1', tenantId: SYSTEM_TENANT_ID, status: WorkflowDefinitionStatus.DRAFT, isActive: false });

/**
 * A promotion double that behaves like the real one: the copy commits inside a transaction, and
 * an `afterWrite` hook (if the service supplies one) runs INSIDE that transaction, so throwing
 * from it rolls the copy back instead of leaving it committed.
 */
let committed: Array<{ id: string }> = [];
const mockAgentPromotion = {
  promote: vi.fn(async (_dto: unknown, options?: { afterWrite?: (definition: unknown) => Promise<void> }) => {
    const definition = SYSTEM_DRAFT();
    // "the transaction"
    const staged = [{ id: definition.id }];
    if (options?.afterWrite) await options.afterWrite(definition);
    committed = staged; // reached only if afterWrite did not throw — i.e. the tx committed
    return { id: 'promo-1', targetDefinitionVersionId: definition.id, warnings: [] };
  }),
};

const construct = () =>
  new WorkflowDefinitionService(
    mockRepository as never,
    mockEventEmitter as never,
    mockClsService as never,
    mockDatabaseService as never,
    mockEntitlements as never,
    undefined,
    undefined,
    undefined,
    undefined,
    mockContextSchemaService as never,
    undefined,
    mockAgentRepository as never,
    undefined,
    undefined,
    undefined,
    mockAgentPromotion as never,
    mockEvalGate as never,
    mockPolicyEngine as never,
  );

describe('WorkflowDefinitionService.promoteToSystem — the publish half (TASK-930 D-4)', () => {
  let service: WorkflowDefinitionService;

  beforeEach(() => {
    vi.clearAllMocks();
    observedTenantIds.length = 0;
    committed = [];
    // The elevated TENANT-LESS context the route requires and the gate ran under.
    currentTenantId = undefined;
    mockEntitlements.isEnforcementEnabled.mockReturnValue(false);
    mockEntitlements.isFeatureEnabled.mockResolvedValue(true);
    mockDatabaseService.baseClient.$transaction.mockImplementation((cb: (tx: unknown) => unknown) => cb({}));
    mockRepository.findPublishedBySlug.mockImplementation((tenantId: string) => Promise.resolve(tenantId === GLOBAL ? entity() : null));
    mockRepository.findById.mockResolvedValue(SYSTEM_DRAFT());
    mockRepository.update.mockImplementation((_id: string, updated: unknown) => Promise.resolve(updated));
    mockRepository.findAllVersionsBySlug.mockResolvedValue([]);
    mockAgentRepository.findPublishedActiveBySlug.mockResolvedValue({ id: 'sys-agent-1', slug: 'x' });
    mockEvalGate.evaluateWorkflowPromotion.mockResolvedValue({
      mode: 'warn',
      evaluated: true,
      passed: true,
      blocked: false,
      failures: [],
      runIds: [],
      aggregates: {},
    });
    service = construct();
  });

  it('publishes the promoted row under the SYSTEM tenant context, never the caller’s tenant-less one', async () => {
    await service.promoteToSystem({ sourceDefinitionSlug: 'general-medicine-consultation' });

    expect(observedTenantIds.length).toBeGreaterThan(0);
    // Every tenant-scoped read the publish makes sees SYSTEM — the tenant that OWNS the row.
    for (const observed of observedTenantIds) expect(observed).toBe(SYSTEM_TENANT_ID);
  });

  it('no longer answers 400 "Tenant ID is required" — the route is reachable end to end', async () => {
    const result = await service.promoteToSystem({ sourceDefinitionSlug: 'general-medicine-consultation' }).catch((caught: unknown) => caught);

    expect(result).not.toBeInstanceOf(BadRequestException);
    expect((result as { published: boolean }).published).toBe(true);
    expect((result as { slug: string }).slug).toBe('general-medicine-consultation');
  });

  it('restores the caller’s tenant-less context after the publish — the scope is borrowed, not kept', async () => {
    await service.promoteToSystem({ sourceDefinitionSlug: 'general-medicine-consultation' });

    expect(currentTenantId).toBeUndefined();
  });

  it('hands the publish to the promotion’s unit of work, so a failing publish leaves NO orphan row', async () => {
    // The publish refuses (a publish-gate refusal, a capability error — the class of failure that
    // survives fixing the tenant context).
    mockContextSchemaService.resolveReference.mockRejectedValueOnce(new BadRequestException('nope'));

    await service.promoteToSystem({ sourceDefinitionSlug: 'general-medicine-consultation' }).catch(() => undefined);

    // The copy must have rolled back with it. Before the fix the publish ran AFTER the commit, so
    // `committed` held the orphan SYSTEM DRAFT the runtime gate found.
    expect(committed).toEqual([]);
    expect(mockAgentPromotion.promote).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ afterWrite: expect.any(Function) }));
  });
});
