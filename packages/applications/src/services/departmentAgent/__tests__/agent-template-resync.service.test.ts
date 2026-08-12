/**
 * Agent golden-library template resync for EXISTING tenants (TASK-548).
 *
 * The SIBLING of `PipelineTemplateResyncService` (TASK-531) — same four
 * conservative rules, applied to the DepartmentAgent family:
 *
 *   (i)   golden agent slug missing for the tenant → clone it in (locked +
 *         lineage + APPROVED template snapshot + v1 version)
 *   (ii)  LOCKED clone, pristine (its bound template content still equals the
 *         golden content at the version it was cloned from) AND behind the
 *         golden template → fast-forward the bound template + bump the anchor
 *   (iii) UNLOCKED clone → never touched (the tenant customized it)
 *   (iv)  LOCKED clone whose bound template content drifted from the golden
 *         source version (an out-of-band edit) → skipped and reported
 *
 * Re-running is a no-op: after a fast-forward the anchor equals the golden
 * current version, so the next run lands in the idempotent skip branch.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentTemplateResyncService } from '../agent-template-resync.service';

const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';
const TARGET_TENANT = 'tenant-42';

const GOLDEN_CONTENT_V1 = 'GOLDEN CONTENT v1';
const GOLDEN_CONTENT_V2 = 'GOLDEN CONTENT v2';
const CUSTOM_CONTENT = 'tenant-customized content';

// TASK-659 defaults ("nothing configured") — every real DepartmentAgentEntity
// carries these; the plain mock objects here must match or `hasLoopConfig`
// (which treats a missing `role` as "configured", since only a hydrated entity
// defaults it to SPECIALIST) would spuriously trigger OP-4's propagation path
// for every pre-existing test in this file.
const NO_LOOP_CONFIG = {
  role: 'SPECIALIST',
  subscribedKinds: null,
  writeScope: null,
  goal: null,
  guardrailProfile: null,
  alwaysActions: null,
  neverActions: null,
};

function goldenAgent(over: Record<string, unknown> = {}) {
  return {
    id: 'sys-agent-gen',
    tenantId: SYSTEM_TENANT_ID,
    departmentId: 'sys-dept-gen',
    name: 'General Practice Default Agent',
    slug: 'gen-default',
    description: 'd',
    promptTemplateId: 'sys-tpl-gen',
    pinnedVersionNumber: null,
    isDefault: true,
    templateLocked: false,
    sourceAgentTemplateSlug: null,
    metaData: null,
    tags: ['golden-library'],
    resourceStatus: 'ENABLED',
    ...NO_LOOP_CONFIG,
    ...over,
  };
}

function tenantAgent(over: Record<string, unknown> = {}) {
  return {
    id: 'ten-agent-gen',
    tenantId: TARGET_TENANT,
    departmentId: 'ten-dept-gen',
    name: 'General Practice Default Agent',
    slug: 'gen-default',
    description: 'd',
    promptTemplateId: 'ten-tpl-gen',
    pinnedVersionNumber: null,
    isDefault: true,
    templateLocked: true,
    sourceAgentTemplateSlug: 'gen-default',
    metaData: { sourceTemplateVersionNumber: 1 },
    tags: ['golden-library'],
    resourceStatus: 'ENABLED',
    version: 1,
    changes: {},
    hasChanges: false,
    ...NO_LOOP_CONFIG,
    ...over,
  };
}

function template(over: Record<string, unknown> = {}) {
  return {
    id: 'tpl',
    tenantId: TARGET_TENANT,
    name: 'Catch-all SOAP',
    description: 'd',
    content: GOLDEN_CONTENT_V1,
    category: 'SUMMARY',
    status: 'APPROVED',
    variables: null,
    currentVersionNumber: 1,
    departmentId: 'dept',
    tags: [],
    version: 1,
    changes: {},
    hasChanges: false,
    ...over,
  };
}

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };

const mockAgentRepo = {
  findAll: vi.fn(),
  findByCode: vi.fn(),
  isSlugUnique: vi.fn(),
  create: vi.fn(),
  updateWithVersion: vi.fn(),
  setDefaultForDepartment: vi.fn(),
  findPrimaryForDepartment: vi.fn(),
};
const mockDeptRepo = {
  findById: vi.fn(),
  findByCode: vi.fn(),
  create: vi.fn(),
};
const mockTemplateRepo = {
  findById: vi.fn(),
  create: vi.fn(),
  updateWithVersion: vi.fn(),
};
const mockVersionRepo = {
  findByVersionNumber: vi.fn(),
  findMaxVersionNumber: vi.fn(),
  create: vi.fn(),
};
// OP-4 (TASK-678) — cross-schema validation deps. Default to "no schema
// declared", which is a SAFE default: it only matters (and only gets called)
// when a test's golden agent actually sets `subscribedKinds`/`writeScope`.
const mockContextSchemaRepo = { findDefaultForScope: vi.fn() };
const mockContextSchemaVersionRepo = { findBySchemaAndVersionNumber: vi.fn() };

describe('AgentTemplateResyncService', () => {
  let service: AgentTemplateResyncService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClsService.get.mockImplementation((key: string) => (key === 'user' ? { id: 'admin-1' } : null));
    mockAgentRepo.create.mockImplementation(async (e: unknown) => e);
    mockAgentRepo.updateWithVersion.mockImplementation(async (_id: string, e: unknown) => e);
    mockAgentRepo.isSlugUnique.mockResolvedValue(true);
    mockAgentRepo.setDefaultForDepartment.mockResolvedValue(undefined);
    mockDeptRepo.findById.mockResolvedValue({
      id: 'sys-dept-gen',
      code: 'GEN',
      name: 'General Practice',
      description: 'd',
      defaultSummaryTemplate: 'SOAP',
      promptConfig: {},
    });
    mockDeptRepo.findByCode.mockResolvedValue({ id: 'ten-dept-gen', code: 'GEN' });
    mockDeptRepo.create.mockImplementation(async (e: any) => ({ ...e, id: 'ten-dept-new' }));
    mockTemplateRepo.create.mockImplementation(async (e: any) => ({ ...e, id: 'ten-tpl-new' }));
    mockTemplateRepo.updateWithVersion.mockImplementation(async (_id: string, e: unknown) => e);
    mockVersionRepo.findMaxVersionNumber.mockResolvedValue(1);
    mockVersionRepo.create.mockImplementation(async (e: unknown) => e);
    mockAgentRepo.findPrimaryForDepartment.mockResolvedValue(null);
    mockContextSchemaRepo.findDefaultForScope.mockResolvedValue(null);
    mockContextSchemaVersionRepo.findBySchemaAndVersionNumber.mockResolvedValue(null);

    service = new AgentTemplateResyncService(
      mockAgentRepo as never,
      mockDeptRepo as never,
      mockTemplateRepo as never,
      mockVersionRepo as never,
      mockContextSchemaRepo as never,
      mockContextSchemaVersionRepo as never,
      mockEventEmitter as never,
      mockClsService as never,
    );
  });

  it('refuses to resync the SYSTEM tenant against itself', async () => {
    await expect(service.resyncTenant(SYSTEM_TENANT_ID)).rejects.toThrow(/SYSTEM/i);
  });

  it('reads the SYSTEM golden agents as the template source', async () => {
    mockAgentRepo.findAll.mockResolvedValue([]);
    await service.resyncTenant(TARGET_TENANT);
    expect(mockAgentRepo.findAll).toHaveBeenCalledWith(expect.objectContaining({ filters: expect.objectContaining({ tenantId: SYSTEM_TENANT_ID }) }));
  });

  // (i) — a golden agent the tenant has never seen.
  it('adds a missing golden agent as a locked clone with lineage + APPROVED snapshot + v1', async () => {
    mockAgentRepo.findAll.mockImplementation(async (props: any) =>
      props.filters.tenantId === SYSTEM_TENANT_ID ? [goldenAgent({ slug: 'brand-new' })] : [],
    );
    mockTemplateRepo.findById.mockResolvedValue(template({ id: 'sys-tpl-gen', content: GOLDEN_CONTENT_V1, currentVersionNumber: 1 }));

    const summary = await service.resyncTenant(TARGET_TENANT);

    expect(summary).toEqual({ added: 1, fastForwarded: 0, skipped: 0, configPropagated: 0, configBlocked: 0 });
    const createdTpl = mockTemplateRepo.create.mock.calls[0][0];
    expect(createdTpl.tenantId).toBe(TARGET_TENANT);
    expect(createdTpl.status).toBe('APPROVED');
    expect(mockVersionRepo.create).toHaveBeenCalledTimes(1);
    const createdAgent = mockAgentRepo.create.mock.calls[0][0];
    expect(createdAgent.templateLocked).toBe(true);
    expect(createdAgent.sourceAgentTemplateSlug).toBe('brand-new');
    expect(createdAgent.metaData).toEqual({ sourceTemplateVersionNumber: 1 });
    // Golden default → tenant default flip.
    expect(mockAgentRepo.setDefaultForDepartment).toHaveBeenCalledTimes(1);
  });

  // TASK-634 D-18 — resync reconciles agents onto the tenant's EXISTING
  // departments; it must never provision a department. The old
  // `resolveOrCreateTenantDepartment` cloned the golden department shape on a
  // miss, which made the SYSTEM golden catalog the de-facto source of every
  // tenant's department list (ArcaAI gained 15 departments in a 629 ms sweep,
  // six of which its clinical model does not have) and made deleting them
  // pointless, because the next sweep recreated them.
  it('D-18: skips a golden agent whose department the tenant does not have, and creates NO department', async () => {
    mockAgentRepo.findAll.mockImplementation(async (props: any) =>
      props.filters.tenantId === SYSTEM_TENANT_ID ? [goldenAgent({ slug: 'brand-new' })] : [],
    );
    mockTemplateRepo.findById.mockResolvedValue(template({ id: 'sys-tpl-gen', content: GOLDEN_CONTENT_V1, currentVersionNumber: 1 }));
    // The tenant has no department with the golden department's code.
    mockDeptRepo.findByCode.mockResolvedValue(null);

    const summary = await service.resyncTenant(TARGET_TENANT);

    expect(summary).toEqual({ added: 0, fastForwarded: 0, skipped: 1, configPropagated: 0, configBlocked: 0 });
    // The whole point: nothing is materialized on a miss.
    expect(mockDeptRepo.create).not.toHaveBeenCalled();
    expect(mockAgentRepo.create).not.toHaveBeenCalled();
    expect(mockTemplateRepo.create).not.toHaveBeenCalled();
    expect(mockVersionRepo.create).not.toHaveBeenCalled();
  });

  // (ii) — a pristine locked clone behind the golden template.
  it('fast-forwards a pristine locked clone when the golden template advanced', async () => {
    mockAgentRepo.findAll.mockImplementation(async (props: any) => (props.filters.tenantId === SYSTEM_TENANT_ID ? [goldenAgent()] : [tenantAgent()]));
    mockTemplateRepo.findById.mockImplementation(async (id: string) => {
      if (id === 'sys-tpl-gen') return template({ id: 'sys-tpl-gen', content: GOLDEN_CONTENT_V2, currentVersionNumber: 2 });
      if (id === 'ten-tpl-gen') return template({ id: 'ten-tpl-gen', content: GOLDEN_CONTENT_V1, currentVersionNumber: 1 });
      return null;
    });
    // Golden content at the anchored version (1) == the tenant clone's content → pristine.
    mockVersionRepo.findByVersionNumber.mockResolvedValue({ content: GOLDEN_CONTENT_V1 });

    const summary = await service.resyncTenant(TARGET_TENANT);

    expect(summary).toEqual({ added: 0, fastForwarded: 1, skipped: 0, configPropagated: 0, configBlocked: 0 });
    // The tenant template content is fast-forwarded to golden current (v2).
    const tplUpdate = mockTemplateRepo.updateWithVersion.mock.calls[0][1];
    expect(tplUpdate.content).toBe(GOLDEN_CONTENT_V2);
    // A new version snapshot is written on the tenant template.
    expect(mockVersionRepo.create).toHaveBeenCalledTimes(1);
    // The clone's anchor is bumped to the golden current version.
    const agentUpdate = mockAgentRepo.updateWithVersion.mock.calls[0][1];
    expect(agentUpdate.metaData).toEqual({ sourceTemplateVersionNumber: 2 });
  });

  // (ii) idempotency — already current.
  it('skips a locked clone already at the golden current version (idempotent)', async () => {
    mockAgentRepo.findAll.mockImplementation(async (props: any) =>
      props.filters.tenantId === SYSTEM_TENANT_ID ? [goldenAgent()] : [tenantAgent({ metaData: { sourceTemplateVersionNumber: 2 } })],
    );
    mockTemplateRepo.findById.mockResolvedValue(template({ id: 'sys-tpl-gen', content: GOLDEN_CONTENT_V2, currentVersionNumber: 2 }));

    const summary = await service.resyncTenant(TARGET_TENANT);

    expect(summary).toEqual({ added: 0, fastForwarded: 0, skipped: 1, configPropagated: 0, configBlocked: 0 });
    expect(mockTemplateRepo.updateWithVersion).not.toHaveBeenCalled();
    expect(mockAgentRepo.updateWithVersion).not.toHaveBeenCalled();
  });

  // (iii) — an unlocked clone is the tenant's own.
  it('never touches an unlocked clone', async () => {
    mockAgentRepo.findAll.mockImplementation(async (props: any) =>
      props.filters.tenantId === SYSTEM_TENANT_ID ? [goldenAgent()] : [tenantAgent({ templateLocked: false })],
    );
    mockTemplateRepo.findById.mockResolvedValue(template({ id: 'sys-tpl-gen', content: GOLDEN_CONTENT_V2, currentVersionNumber: 2 }));

    const summary = await service.resyncTenant(TARGET_TENANT);

    expect(summary).toEqual({ added: 0, fastForwarded: 0, skipped: 1, configPropagated: 0, configBlocked: 0 });
    expect(mockTemplateRepo.updateWithVersion).not.toHaveBeenCalled();
    expect(mockAgentRepo.updateWithVersion).not.toHaveBeenCalled();
  });

  // TASK-635 R4 — the ArcaAI hazard, closed STRUCTURALLY.
  //
  // RF-3 gave the ArcaAI tenant 7 tenant-owned per-visit-type agents seeded with
  // the GOLDEN SLUGS. That is deliberate and load-bearing: rule (i) clones a
  // golden agent only when its slug is ABSENT for the tenant, so matching slugs
  // make the nightly sweep add nothing, and rule (iii) ("never touch an unlocked
  // row") then protects them forever. Without matching slugs the sweep would
  // clone in a SECOND default agent bound to the catch-all SOAP template, which
  // resolves ONE prompt for both visit types — silently re-collapsing v1's
  // new-referral vs follow-up split (F-01) on a tenant that had it right.
  it('R4: an unlocked tenant agent occupying the golden slug makes the sweep a complete no-op', async () => {
    mockAgentRepo.findAll.mockImplementation(async (props: any) =>
      props.filters.tenantId === SYSTEM_TENANT_ID
        ? [goldenAgent()]
        : [
            // Shaped like a seeded ArcaAI row: golden slug, unlocked, no lineage,
            // per-visit-type bindings of its own.
            tenantAgent({
              id: 'arcaai-agent-gen',
              slug: 'gen-default',
              templateLocked: false,
              sourceAgentTemplateSlug: null,
              metaData: null,
              promptTemplateId: 'arcaai-new-referral',
              newPatientTemplateId: 'arcaai-new-referral',
              revisitTemplateId: 'arcaai-followup',
            }),
          ],
    );
    mockTemplateRepo.findById.mockResolvedValue(template({ id: 'sys-tpl-gen', content: GOLDEN_CONTENT_V2, currentVersionNumber: 2 }));

    const summary = await service.resyncTenant(TARGET_TENANT);

    expect(summary.added).toBe(0);
    expect(summary.fastForwarded).toBe(0);
    // Nothing is created and nothing is re-pointed — in particular no second
    // default agent appears to fight the seeded one over `isDefault`.
    expect(mockAgentRepo.create).not.toHaveBeenCalled();
    expect(mockAgentRepo.setDefaultForDepartment).not.toHaveBeenCalled();
    expect(mockAgentRepo.updateWithVersion).not.toHaveBeenCalled();
    expect(mockTemplateRepo.updateWithVersion).not.toHaveBeenCalled();
  });

  // (iv) — a locked clone whose bound template drifted (out-of-band edit).
  it('skips a drifted locked clone and never overwrites it', async () => {
    mockAgentRepo.findAll.mockImplementation(async (props: any) => (props.filters.tenantId === SYSTEM_TENANT_ID ? [goldenAgent()] : [tenantAgent()]));
    mockTemplateRepo.findById.mockImplementation(async (id: string) => {
      if (id === 'sys-tpl-gen') return template({ id: 'sys-tpl-gen', content: GOLDEN_CONTENT_V2, currentVersionNumber: 2 });
      // Tenant content diverged from the golden source version → drifted.
      if (id === 'ten-tpl-gen') return template({ id: 'ten-tpl-gen', content: CUSTOM_CONTENT, currentVersionNumber: 1 });
      return null;
    });
    mockVersionRepo.findByVersionNumber.mockResolvedValue({ content: GOLDEN_CONTENT_V1 });

    const summary = await service.resyncTenant(TARGET_TENANT);

    expect(summary).toEqual({ added: 0, fastForwarded: 0, skipped: 1, configPropagated: 0, configBlocked: 0 });
    expect(mockTemplateRepo.updateWithVersion).not.toHaveBeenCalled();
  });

  it('per-row isolation — one bad golden agent does not abort the rest', async () => {
    mockAgentRepo.findAll.mockImplementation(async (props: any) =>
      props.filters.tenantId === SYSTEM_TENANT_ID
        ? [
            goldenAgent({ id: 'g1', slug: 'boom', departmentId: 'sys-dept-boom' }),
            goldenAgent({ id: 'g2', slug: 'ok-new', departmentId: 'sys-dept-ok' }),
          ]
        : [],
    );
    mockDeptRepo.findByCode.mockResolvedValue({ id: 'ten-dept', code: 'X' });
    mockTemplateRepo.findById.mockResolvedValue(template({ content: GOLDEN_CONTENT_V1, currentVersionNumber: 1 }));
    // The first clone's agent create throws; the second still lands.
    mockAgentRepo.create.mockImplementation(async (e: any) => {
      if (e.slug === 'boom') throw new Error('unique violation');
      return e;
    });

    const summary = await service.resyncTenant(TARGET_TENANT);

    expect(summary.added).toBe(1);
    expect(summary.skipped).toBe(1);
  });

  it('no golden agents → all-zero summary', async () => {
    mockAgentRepo.findAll.mockResolvedValue([]);
    const summary = await service.resyncTenant(TARGET_TENANT);
    expect(summary).toEqual({ added: 0, fastForwarded: 0, skipped: 0, configPropagated: 0, configBlocked: 0 });
  });

  // =========================================================================
  // OP-4 (TASK-678) — the seven TASK-659 loop-config fields now propagate at
  // the SAME two proven-safe points (clone + content fast-forward), validated
  // the same way AgentPromotionService validates a cross-tenant write, and
  // never silently: every block is logged and counted.
  // =========================================================================

  it('OP-4 clone: propagates loop config from a golden agent that configures the loop surface', async () => {
    mockAgentRepo.findAll.mockImplementation(async (props: any) =>
      props.filters.tenantId === SYSTEM_TENANT_ID ? [goldenAgent({ slug: 'brand-new', guardrailProfile: 'STRICT', alwaysActions: ['harness.finalize'] })] : [],
    );
    mockTemplateRepo.findById.mockResolvedValue(template({ id: 'sys-tpl-gen', content: GOLDEN_CONTENT_V1, currentVersionNumber: 1 }));

    const summary = await service.resyncTenant(TARGET_TENANT);

    expect(summary).toEqual({ added: 1, fastForwarded: 0, skipped: 0, configPropagated: 1, configBlocked: 0 });
    const createdAgent = mockAgentRepo.create.mock.calls[0][0];
    expect(createdAgent.role).toBe('SPECIALIST');
    expect(createdAgent.guardrailProfile).toBe('STRICT');
    expect(createdAgent.alwaysActions).toEqual(['harness.finalize']);
  });

  it('OP-4 clone: a golden PRIMARY colliding with an existing target PRIMARY is blocked, logged, and counted — the clone still lands unconfigured', async () => {
    mockAgentRepo.findAll.mockImplementation(async (props: any) =>
      props.filters.tenantId === SYSTEM_TENANT_ID ? [goldenAgent({ slug: 'brand-new', role: 'PRIMARY' })] : [],
    );
    mockTemplateRepo.findById.mockResolvedValue(template({ id: 'sys-tpl-gen', content: GOLDEN_CONTENT_V1, currentVersionNumber: 1 }));
    mockAgentRepo.findPrimaryForDepartment.mockResolvedValue({ id: 'other-primary', slug: 'existing-primary' });

    const summary = await service.resyncTenant(TARGET_TENANT);

    expect(summary).toEqual({ added: 1, fastForwarded: 0, skipped: 0, configPropagated: 0, configBlocked: 1 });
    // Still created (template + lineage) — just without the seven fields, so
    // the one-PRIMARY-per-department invariant is never put at risk.
    const createdAgent = mockAgentRepo.create.mock.calls[0][0];
    expect(createdAgent.role).toBe('SPECIALIST');
  });

  it('OP-4 clone: a golden subscribedKinds referencing a kind the target department has not declared is blocked and counted', async () => {
    mockAgentRepo.findAll.mockImplementation(async (props: any) =>
      props.filters.tenantId === SYSTEM_TENANT_ID
        ? [goldenAgent({ slug: 'brand-new', subscribedKinds: { version: 1, kinds: [{ key: 'referral_letter' }] } })]
        : [],
    );
    mockTemplateRepo.findById.mockResolvedValue(template({ id: 'sys-tpl-gen', content: GOLDEN_CONTENT_V1, currentVersionNumber: 1 }));
    // No published context schema for the target department/tenant.
    mockContextSchemaRepo.findDefaultForScope.mockResolvedValue(null);

    const summary = await service.resyncTenant(TARGET_TENANT);

    expect(summary).toEqual({ added: 1, fastForwarded: 0, skipped: 0, configPropagated: 0, configBlocked: 1 });
    const createdAgent = mockAgentRepo.create.mock.calls[0][0];
    expect(createdAgent.subscribedKinds).toBeNull();
  });

  it('OP-4 fast-forward: propagates a loop-config change at the SAME sync point as a content fast-forward', async () => {
    mockAgentRepo.findAll.mockImplementation(async (props: any) =>
      props.filters.tenantId === SYSTEM_TENANT_ID ? [goldenAgent({ guardrailProfile: 'STRICT' })] : [tenantAgent()],
    );
    mockTemplateRepo.findById.mockImplementation(async (id: string) => {
      if (id === 'sys-tpl-gen') return template({ id: 'sys-tpl-gen', content: GOLDEN_CONTENT_V2, currentVersionNumber: 2 });
      if (id === 'ten-tpl-gen') return template({ id: 'ten-tpl-gen', content: GOLDEN_CONTENT_V1, currentVersionNumber: 1 });
      return null;
    });
    mockVersionRepo.findByVersionNumber.mockResolvedValue({ content: GOLDEN_CONTENT_V1 });

    const summary = await service.resyncTenant(TARGET_TENANT);

    expect(summary).toEqual({ added: 0, fastForwarded: 1, skipped: 0, configPropagated: 1, configBlocked: 0 });
    const agentUpdate = mockAgentRepo.updateWithVersion.mock.calls[0][1];
    expect(agentUpdate.guardrailProfile).toBe('STRICT');
  });

  it('OP-4 fast-forward: a golden PRIMARY colliding with a DIFFERENT existing PRIMARY is blocked — content still fast-forwards, config does not', async () => {
    mockAgentRepo.findAll.mockImplementation(async (props: any) =>
      props.filters.tenantId === SYSTEM_TENANT_ID ? [goldenAgent({ role: 'PRIMARY' })] : [tenantAgent()],
    );
    mockTemplateRepo.findById.mockImplementation(async (id: string) => {
      if (id === 'sys-tpl-gen') return template({ id: 'sys-tpl-gen', content: GOLDEN_CONTENT_V2, currentVersionNumber: 2 });
      if (id === 'ten-tpl-gen') return template({ id: 'ten-tpl-gen', content: GOLDEN_CONTENT_V1, currentVersionNumber: 1 });
      return null;
    });
    mockVersionRepo.findByVersionNumber.mockResolvedValue({ content: GOLDEN_CONTENT_V1 });
    // A DIFFERENT agent already holds PRIMARY in this department.
    mockAgentRepo.findPrimaryForDepartment.mockResolvedValue({ id: 'other-primary', slug: 'existing-primary' });

    const summary = await service.resyncTenant(TARGET_TENANT);

    expect(summary).toEqual({ added: 0, fastForwarded: 1, skipped: 0, configPropagated: 0, configBlocked: 1 });
    // Content DID fast-forward (the four existing rules are unaffected by OP-4).
    const tplUpdate = mockTemplateRepo.updateWithVersion.mock.calls[0][1];
    expect(tplUpdate.content).toBe(GOLDEN_CONTENT_V2);
    // But the role write never happened — one-PRIMARY-per-department held.
    const agentUpdate = mockAgentRepo.updateWithVersion.mock.calls[0][1];
    expect(agentUpdate.role).toBe('SPECIALIST');
  });

  it('OP-4: findPrimaryForDepartment excludes the row being fast-forwarded itself, so a golden PRIMARY re-affirming the SAME row is not its own conflict', async () => {
    // role PRIMARY on both sides (not itself a change) but guardrailProfile
    // differs, so the config snapshot still differs and validation still runs.
    mockAgentRepo.findAll.mockImplementation(async (props: any) =>
      props.filters.tenantId === SYSTEM_TENANT_ID
        ? [goldenAgent({ role: 'PRIMARY', guardrailProfile: 'STRICT' })]
        : [tenantAgent({ role: 'PRIMARY', guardrailProfile: null })],
    );
    mockTemplateRepo.findById.mockImplementation(async (id: string) => {
      if (id === 'sys-tpl-gen') return template({ id: 'sys-tpl-gen', content: GOLDEN_CONTENT_V2, currentVersionNumber: 2 });
      if (id === 'ten-tpl-gen') return template({ id: 'ten-tpl-gen', content: GOLDEN_CONTENT_V1, currentVersionNumber: 1 });
      return null;
    });
    mockVersionRepo.findByVersionNumber.mockResolvedValue({ content: GOLDEN_CONTENT_V1 });
    // No OTHER row holds PRIMARY — the row being fast-forwarded is itself the
    // only PRIMARY, and it must be excluded from its own conflict check.
    mockAgentRepo.findPrimaryForDepartment.mockResolvedValue(null);

    const summary = await service.resyncTenant(TARGET_TENANT);

    expect(mockAgentRepo.findPrimaryForDepartment).toHaveBeenCalledWith(TARGET_TENANT, 'ten-dept-gen', 'ten-agent-gen');
    expect(summary.configPropagated).toBe(1);
    expect(summary.configBlocked).toBe(0);
    const agentUpdate = mockAgentRepo.updateWithVersion.mock.calls[0][1];
    expect(agentUpdate.guardrailProfile).toBe('STRICT');
  });

  it('OP-4: config already matching golden is a no-op even when content also fast-forwards', async () => {
    mockAgentRepo.findAll.mockImplementation(async (props: any) =>
      props.filters.tenantId === SYSTEM_TENANT_ID ? [goldenAgent({ guardrailProfile: 'STRICT' })] : [tenantAgent({ guardrailProfile: 'STRICT' })],
    );
    mockTemplateRepo.findById.mockImplementation(async (id: string) => {
      if (id === 'sys-tpl-gen') return template({ id: 'sys-tpl-gen', content: GOLDEN_CONTENT_V2, currentVersionNumber: 2 });
      if (id === 'ten-tpl-gen') return template({ id: 'ten-tpl-gen', content: GOLDEN_CONTENT_V1, currentVersionNumber: 1 });
      return null;
    });
    mockVersionRepo.findByVersionNumber.mockResolvedValue({ content: GOLDEN_CONTENT_V1 });

    const summary = await service.resyncTenant(TARGET_TENANT);

    expect(summary).toEqual({ added: 0, fastForwarded: 1, skipped: 0, configPropagated: 0, configBlocked: 0 });
  });
});
