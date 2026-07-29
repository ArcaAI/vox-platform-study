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

    service = new AgentTemplateResyncService(
      mockAgentRepo as never,
      mockDeptRepo as never,
      mockTemplateRepo as never,
      mockVersionRepo as never,
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

    expect(summary).toEqual({ added: 1, fastForwarded: 0, skipped: 0 });
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

    expect(summary).toEqual({ added: 0, fastForwarded: 1, skipped: 0 });
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

    expect(summary).toEqual({ added: 0, fastForwarded: 0, skipped: 1 });
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

    expect(summary).toEqual({ added: 0, fastForwarded: 0, skipped: 1 });
    expect(mockTemplateRepo.updateWithVersion).not.toHaveBeenCalled();
    expect(mockAgentRepo.updateWithVersion).not.toHaveBeenCalled();
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

    expect(summary).toEqual({ added: 0, fastForwarded: 0, skipped: 1 });
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
    expect(summary).toEqual({ added: 0, fastForwarded: 0, skipped: 0 });
  });
});
