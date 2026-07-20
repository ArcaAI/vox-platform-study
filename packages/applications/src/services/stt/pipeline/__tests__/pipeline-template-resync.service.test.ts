/**
 * TASK-531 (GAP-T3) — template resync for EXISTING tenants.
 *
 * Clone-on-provision only ever ran once, at tenant creation. A tenant created
 * before a new SYSTEM template existed never receives it, and a template whose
 * YAML improves afterwards leaves every tenant copy frozen at clone time. The
 * reconciler closes both gaps, and it is deliberately CONSERVATIVE:
 *
 *   (i)   template slug missing for the tenant  → clone it in (locked + lineage)
 *   (ii)  locked copy, consistent with its own version history, YAML behind
 *         SYSTEM                                 → fast-forward + new snapshot
 *   (iii) UNLOCKED row                           → never touched (it is either
 *         customized or was left unlocked by the ambiguous-backfill branch)
 *   (iv)  locked copy that drifted from its own snapshot (an out-of-band DB
 *         edit) → skipped and reported, never overwritten
 *
 * Re-running must be a no-op, because this runs both from an admin button and
 * from a nightly cron.
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { PipelineTemplateResyncService } from '../pipeline-template-resync.service';

const SYSTEM_TENANT_ID = '00000000-0000-0000-0000-000000000000';
const TARGET_TENANT = 'tenant-42';

const SysEventType = {
  ResourceCreated: 'SysEvent.ResourceCreated',
  ResourceUpdated: 'SysEvent.ResourceUpdated',
} as const;

const TEMPLATE_YAML_V1 = 'version: "1.0"\nmodels:\n  asr: "whisper-v1"\n';
const TEMPLATE_YAML_V2 = 'version: "1.0"\nmodels:\n  asr: "whisper-v2"\n';
const CUSTOM_YAML = 'version: "1.0"\nmodels:\n  asr: "customized"\n';

function pipeline(overrides: Record<string, unknown> = {}) {
  const base = {
    id: 'p-1',
    tenantId: TARGET_TENANT,
    name: 'Production Whisper',
    slug: 'production-whisper',
    description: 'desc',
    configYaml: TEMPLATE_YAML_V1,
    tags: ['matrix'],
    isDefault: false,
    templateLocked: false,
    sourceTemplateSlug: null,
    version: 1,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    createdBy: null,
    updatedBy: null,
    changes: {},
    hasChanges: false,
  };
  return { ...base, ...overrides };
}

const mockClsService = { get: vi.fn(), set: vi.fn() };
const mockEventEmitter = { emit: vi.fn() };

const mockPipelineRepository = {
  findEnabledPipelines: vi.fn(),
  findAllForAdmin: vi.fn(),
  findById: vi.fn(),
  create: vi.fn(),
  update: vi.fn(),
  updateWithVersion: vi.fn(),
  isSlugUnique: vi.fn(),
  setDefaultForTenant: vi.fn(),
};

const mockVersionRepository = {
  getNextVersionNumber: vi.fn(),
  create: vi.fn(),
  findByPipeline: vi.fn(),
};

describe('PipelineTemplateResyncService', () => {
  let service: PipelineTemplateResyncService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockClsService.get.mockImplementation((key: string) =>
      key === 'user' ? { id: 'admin-1' } : null,
    );
    mockPipelineRepository.create.mockImplementation(async (e: unknown) => e);
    mockPipelineRepository.updateWithVersion.mockImplementation(async (_id: string, e: unknown) => e);
    mockVersionRepository.getNextVersionNumber.mockResolvedValue(1);
    mockVersionRepository.findByPipeline.mockResolvedValue([]);

    service = new PipelineTemplateResyncService(
      mockPipelineRepository as never,
      mockVersionRepository as never,
      mockEventEmitter as never,
      mockClsService as never,
    );
  });

  it('reads the SYSTEM catalog as the template source', async () => {
    mockPipelineRepository.findEnabledPipelines.mockResolvedValue([]);
    mockPipelineRepository.findAllForAdmin.mockResolvedValue([]);

    await service.resyncTenant(TARGET_TENANT);

    expect(mockPipelineRepository.findEnabledPipelines).toHaveBeenCalledWith(SYSTEM_TENANT_ID);
  });

  // (i) — a template the tenant has never seen
  it('adds a missing template as a locked copy with lineage and a v1 snapshot', async () => {
    mockPipelineRepository.findEnabledPipelines.mockResolvedValue([
      pipeline({ id: 'sys-1', tenantId: SYSTEM_TENANT_ID, slug: 'brand-new', configYaml: TEMPLATE_YAML_V2 }),
    ]);
    mockPipelineRepository.findAllForAdmin.mockResolvedValue([]);

    const summary = await service.resyncTenant(TARGET_TENANT);

    expect(summary).toEqual({ added: 1, fastForwarded: 0, skipped: 0 });

    const created = mockPipelineRepository.create.mock.calls[0][0];
    expect(created.tenantId).toBe(TARGET_TENANT);
    expect(created.slug).toBe('brand-new');
    expect(created.templateLocked).toBe(true);
    expect(created.sourceTemplateSlug).toBe('brand-new');
    expect(created.configYaml).toBe(TEMPLATE_YAML_V2);

    expect(mockVersionRepository.create).toHaveBeenCalledTimes(1);
    expect(mockEventEmitter.emit).toHaveBeenCalledWith(
      SysEventType.ResourceCreated,
      expect.objectContaining({ data: expect.objectContaining({ tenantId: TARGET_TENANT }) }),
    );
  });

  // (ii) — the template moved on; the copy is pristine, so carry it forward
  it('fast-forwards a pristine locked copy to the SYSTEM config and snapshots it', async () => {
    mockPipelineRepository.findEnabledPipelines.mockResolvedValue([
      pipeline({ id: 'sys-1', tenantId: SYSTEM_TENANT_ID, slug: 'prod', configYaml: TEMPLATE_YAML_V2 }),
    ]);
    const copy = pipeline({
      id: 'copy-1',
      slug: 'prod',
      configYaml: TEMPLATE_YAML_V1,
      templateLocked: true,
      sourceTemplateSlug: 'prod',
    });
    mockPipelineRepository.findAllForAdmin.mockResolvedValue([copy]);
    // Consistent with its own history: latest snapshot == current YAML.
    mockVersionRepository.findByPipeline.mockResolvedValue([
      { versionNumber: 1, configYaml: TEMPLATE_YAML_V1 },
    ]);
    mockVersionRepository.getNextVersionNumber.mockResolvedValue(2);

    const summary = await service.resyncTenant(TARGET_TENANT);

    expect(summary).toEqual({ added: 0, fastForwarded: 1, skipped: 0 });
    expect(copy.configYaml).toBe(TEMPLATE_YAML_V2);
    expect(mockPipelineRepository.updateWithVersion).toHaveBeenCalled();
    // Stays locked — a fast-forward does not unlock the copy.
    expect(copy.templateLocked).toBe(true);
    expect(mockVersionRepository.create).toHaveBeenCalledTimes(1);
    expect(mockVersionRepository.create.mock.calls[0][0].configYaml).toBe(TEMPLATE_YAML_V2);
    expect(mockEventEmitter.emit).toHaveBeenCalledWith(
      SysEventType.ResourceUpdated,
      expect.objectContaining({ resourceId: 'copy-1' }),
    );
  });

  // (iii) — the customer's own work is untouchable
  it('never touches an UNLOCKED row, even when its slug matches a template', async () => {
    mockPipelineRepository.findEnabledPipelines.mockResolvedValue([
      pipeline({ id: 'sys-1', tenantId: SYSTEM_TENANT_ID, slug: 'prod', configYaml: TEMPLATE_YAML_V2 }),
    ]);
    mockPipelineRepository.findAllForAdmin.mockResolvedValue([
      pipeline({ id: 'mine-1', slug: 'prod', configYaml: CUSTOM_YAML, templateLocked: false }),
    ]);

    const summary = await service.resyncTenant(TARGET_TENANT);

    expect(summary).toEqual({ added: 0, fastForwarded: 0, skipped: 1 });
    expect(mockPipelineRepository.updateWithVersion).not.toHaveBeenCalled();
    expect(mockPipelineRepository.create).not.toHaveBeenCalled();
  });

  // (iv) — locked but drifted from its own history: an out-of-band edit
  it('skips a locked copy that drifted from its own latest snapshot', async () => {
    mockPipelineRepository.findEnabledPipelines.mockResolvedValue([
      pipeline({ id: 'sys-1', tenantId: SYSTEM_TENANT_ID, slug: 'prod', configYaml: TEMPLATE_YAML_V2 }),
    ]);
    mockPipelineRepository.findAllForAdmin.mockResolvedValue([
      pipeline({ id: 'copy-1', slug: 'prod', configYaml: CUSTOM_YAML, templateLocked: true, sourceTemplateSlug: 'prod' }),
    ]);
    mockVersionRepository.findByPipeline.mockResolvedValue([
      { versionNumber: 1, configYaml: TEMPLATE_YAML_V1 },
    ]);

    const summary = await service.resyncTenant(TARGET_TENANT);

    expect(summary).toEqual({ added: 0, fastForwarded: 0, skipped: 1 });
    expect(mockPipelineRepository.updateWithVersion).not.toHaveBeenCalled();
  });

  it('is idempotent — an already-current locked copy is a no-op', async () => {
    mockPipelineRepository.findEnabledPipelines.mockResolvedValue([
      pipeline({ id: 'sys-1', tenantId: SYSTEM_TENANT_ID, slug: 'prod', configYaml: TEMPLATE_YAML_V2 }),
    ]);
    mockPipelineRepository.findAllForAdmin.mockResolvedValue([
      pipeline({ id: 'copy-1', slug: 'prod', configYaml: TEMPLATE_YAML_V2, templateLocked: true, sourceTemplateSlug: 'prod' }),
    ]);
    mockVersionRepository.findByPipeline.mockResolvedValue([
      { versionNumber: 2, configYaml: TEMPLATE_YAML_V2 },
    ]);

    const summary = await service.resyncTenant(TARGET_TENANT);

    expect(summary).toEqual({ added: 0, fastForwarded: 0, skipped: 1 });
    expect(mockPipelineRepository.updateWithVersion).not.toHaveBeenCalled();
    expect(mockVersionRepository.create).not.toHaveBeenCalled();
  });

  it('never resyncs the SYSTEM tenant into itself', async () => {
    await expect(service.resyncTenant(SYSTEM_TENANT_ID)).rejects.toThrow(/SYSTEM/i);
    expect(mockPipelineRepository.create).not.toHaveBeenCalled();
  });

  it('isolates per-row failures so one bad template cannot abort the run', async () => {
    mockPipelineRepository.findEnabledPipelines.mockResolvedValue([
      pipeline({ id: 'sys-1', tenantId: SYSTEM_TENANT_ID, slug: 'boom' }),
      pipeline({ id: 'sys-2', tenantId: SYSTEM_TENANT_ID, slug: 'fine' }),
    ]);
    mockPipelineRepository.findAllForAdmin.mockResolvedValue([]);
    mockPipelineRepository.create
      .mockRejectedValueOnce(new Error('constraint violation'))
      .mockImplementationOnce(async (e: unknown) => e);

    const summary = await service.resyncTenant(TARGET_TENANT);

    expect(summary).toEqual({ added: 1, fastForwarded: 0, skipped: 1 });
  });
});
