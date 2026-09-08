/**
 * TASK-930 D-5 — a reference-set clone must land PUBLISHED, or provisioning means nothing.
 *
 * ## What the local runtime gate found (§6.9, `EVIDENCE.md` §3c)
 *
 * A brand-new tenant synced from SYSTEM came out with:
 *
 * ```
 * workflowDefinitions (2): general-medicine-consultation  DRAFT v1  active:false
 *                          platform-default-summarization DRAFT v1  active:false
 * workflowAssignments: []   ← "No PUBLISHED 'core' workflow definition with slug '…'"
 * ```
 *
 * The agent half was correct (6 SYSTEM agents, 4 TENANT assignments, provenance stamped); the
 * workflow half left the tenant with a library it could not run.
 *
 * ## Why DRAFT was wrong HERE specifically
 *
 * `cloneFromSystem` inherited the DRAFT posture from the ad-hoc `clone` verb, whose reasoning is
 * sound for what it does: a workflow a tenant admin copies by hand has been reviewed by nobody,
 * so it must not silently become the graph serving consultations. But the REFERENCE SET is not an
 * ad-hoc copy — it is the platform provisioning a tenant from a template the platform admin
 * already reviewed and PUBLISHED into SYSTEM, and `WorkflowAssignmentService` refuses to point an
 * assignment at anything but a PUBLISHED + ACTIVE definition. So DRAFT here does not mean
 * "awaiting review"; it means the very next step of the same sync fails.
 *
 * The seed copier (`seed/26-tenant-reference-set.ts`) already writes these clones `PUBLISHED` +
 * `isActive`, re-stamped for their new owner — so the runtime service was also the ODD ONE OUT,
 * and `tenant-reference-set-parity.contract.test.ts` exists precisely to stop the two copiers
 * drifting.
 *
 * Publishing through `publishEntity` (rather than hand-stamping the columns as the seed must,
 * having no service layer) is what "re-stamped for its new owner" means at runtime: it recompiles
 * the graph against the TENANT's own catalogue and context-schema pin and writes that tenant's
 * `compiledConfig` + checksum, instead of copying an artifact that names SYSTEM's rows.
 *
 * Written RED-first against `06af5371e`: the clone was DRAFT / `isActive:false` with a null
 * `compiledConfig`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { SYSTEM_TENANT_ID, WorkflowDefinitionStatus } from '@arcaai/domains';
import { WorkflowDefinitionService } from '../workflow-definition.service';

const TENANT = 'tenant-1';
const SCHEMA_ID = '79000000-0000-0000-0001-000000000010';

let currentTenantId: string | undefined;
const mockClsService = {
  get: vi.fn((key: string) => {
    if (key === 'tenantId') return currentTenantId;
    if (key === 'user') return { id: 'admin-1', roles: ['TENANT_ADMIN'] };
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

const SYSTEM_GRAPH = {
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

const SYSTEM_TEMPLATE = {
  id: 'sys-tpl-1',
  tenantId: SYSTEM_TENANT_ID,
  slug: 'general-medicine-consultation',
  name: 'General medicine consultation',
  description: 'The platform template',
  paletteKey: 'core',
  versionNumber: 1,
  status: WorkflowDefinitionStatus.PUBLISHED,
  graph: SYSTEM_GRAPH,
  isActive: true,
  resourceStatus: 'ENABLED',
};

/** Whatever `repository.create` was handed — the row the tenant ends up with. */
let createdEntity: Record<string, unknown> | undefined;

const mockRepository = {
  findSystemTemplates: vi.fn(async () => [SYSTEM_TEMPLATE]),
  findCloneSource: vi.fn(async () => SYSTEM_TEMPLATE),
  findMaxVersionNumber: vi.fn(async () => 0),
  findAllVersionsBySlug: vi.fn(async () => []),
  findPublishedBySlug: vi.fn(async () => null),
  findById: vi.fn(async () => createdEntity),
  count: vi.fn(async () => 0),
  create: vi.fn(async (entity: Record<string, unknown>) => {
    createdEntity = entity;
    return entity;
  }),
  update: vi.fn(async (_id: string, updated: Record<string, unknown>) => {
    createdEntity = updated;
    return updated;
  }),
};

const mockDatabaseService = { baseClient: { $transaction: vi.fn((cb: (tx: unknown) => unknown) => cb({})) } };
const mockEntitlements = {
  isEnforcementEnabled: vi.fn(() => false),
  assertQuantityQuota: vi.fn(),
  isFeatureEnabled: vi.fn(async () => true),
};
const mockEventEmitter = { emit: vi.fn() };
const mockAgentRepository = { findPublishedActiveBySlug: vi.fn(async () => ({ id: 'agent-1', slug: 'x' })) };

/** Records which tenant each context-schema read was made under. */
const observedTenantIds: Array<string | undefined> = [];
const mockContextSchemaService = {
  getEffectiveBundle: vi.fn(async () => {
    observedTenantIds.push(currentTenantId);
    return { contextSchemaVersionId: 'tenant-ctx-version-1' };
  }),
  resolveReference: vi.fn(async () => {
    observedTenantIds.push(currentTenantId);
    return {
      outcome: 'resolved' as const,
      schemaId: SCHEMA_ID,
      versionNumber: 1,
      versionId: 'tenant-ctx-version-1',
      payloadSchema: {
        type: 'object',
        additionalProperties: false,
        properties: { intake: { type: 'object', properties: { severity: { type: 'string' } } } },
      },
    };
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
    undefined,
    undefined,
    undefined,
  );

describe('WorkflowDefinitionService.cloneFromSystem — the reference-set copy (TASK-930 D-5)', () => {
  let service: WorkflowDefinitionService;

  beforeEach(() => {
    vi.clearAllMocks();
    createdEntity = undefined;
    observedTenantIds.length = 0;
    currentTenantId = undefined;
    mockRepository.findSystemTemplates.mockResolvedValue([SYSTEM_TEMPLATE] as never);
    mockRepository.findCloneSource.mockResolvedValue(SYSTEM_TEMPLATE as never);
    mockRepository.findMaxVersionNumber.mockResolvedValue(0 as never);
    mockRepository.findPublishedBySlug.mockResolvedValue(null as never);
    mockEntitlements.isEnforcementEnabled.mockReturnValue(false);
    mockDatabaseService.baseClient.$transaction.mockImplementation((cb: (tx: unknown) => unknown) => cb({}));
    service = construct();
  });

  it('lands the clone PUBLISHED and ACTIVE, so a TENANT assignment can point at it', async () => {
    const result = await service.cloneFromSystem('general-medicine-consultation', TENANT);

    expect(result.created).toBe(true);
    expect(createdEntity).toBeDefined();
    // Before the fix these were DRAFT / false, and `workflowAssignments` then failed with
    // "No PUBLISHED 'core' workflow definition with slug 'general-medicine-consultation'".
    expect(createdEntity!.status).toBe(WorkflowDefinitionStatus.PUBLISHED);
    expect(createdEntity!.isActive).toBe(true);
    expect(createdEntity!.publishedAt).toBeInstanceOf(Date);
  });

  it('re-stamps the artifact for its new owner — compiled against the TENANT, not copied from SYSTEM', async () => {
    await service.cloneFromSystem('general-medicine-consultation', TENANT);

    // A published row carries its own compiled artifact + checksum; a null one is an unpublished
    // row wearing a published status.
    expect(createdEntity!.compiledConfig).toBeTruthy();
    expect(createdEntity!.compiledConfigChecksum).toEqual(expect.any(String));
    // And every schema read that produced it was made under the TARGET tenant.
    expect(observedTenantIds.length).toBeGreaterThan(0);
    for (const observed of observedTenantIds) expect(observed).toBe(TENANT);
  });

  it('stamps the reference-set provenance the agent clone already carried', async () => {
    await service.cloneFromSystem('general-medicine-consultation', TENANT);

    expect(createdEntity!.sourceTemplateSlug).toBe('general-medicine-consultation');
    expect(createdEntity!.templateLocked).toBe(true);
  });

  it('restores the caller’s context and is missing-only — an existing clone is left alone', async () => {
    mockRepository.findMaxVersionNumber.mockResolvedValue(1 as never);
    mockRepository.findAllVersionsBySlug.mockResolvedValue([{ id: 'existing-1' }] as never);

    const result = await service.cloneFromSystem('general-medicine-consultation', TENANT);

    expect(result).toEqual({ definitionId: 'existing-1', created: false });
    expect(mockRepository.create).not.toHaveBeenCalled();
    expect(mockRepository.update).not.toHaveBeenCalled();
    expect(currentTenantId).toBeUndefined();
  });
});
