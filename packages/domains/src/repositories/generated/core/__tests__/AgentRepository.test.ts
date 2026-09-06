/**
 * TASK-863 — AgentRepository shape: the published-and-active predicate is written ONCE and
 * shared by the by-slug and list reads; the widened read covers exactly [tenant, SYSTEM].
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SYSTEM_TENANT_ID } from '@arcaai/database';
import { DataNotFoundException } from '@arcaai/exceptions';
import { AgentRepository } from '../AgentRepository';
import { AgentAssignmentRepository } from '../AgentAssignmentRepository';
import { AgentTask, PipelinePolicyScope, ResourceStatusType, WorkflowDefinitionStatus } from '../../../../enums';

const row = {
  id: 'agent-1',
  tenantId: 'tenant-1',
  slug: 'platform-summarization',
  name: 'Summarization',
  description: null,
  task: AgentTask.TEXT_GENERATION,
  versionNumber: 2,
  parentVersionId: null,
  status: WorkflowDefinitionStatus.PUBLISHED,
  isActive: true,
  modelId: 'model-1',
  instruction: null,
  parameters: null,
  inputSchema: null,
  outputSchema: null,
  tools: null,
  compiledConfig: { models: [] },
  compiledConfigChecksum: 'sha256:x',
  validationReport: null,
  validatedAt: null,
  publishedAt: new Date(),
  deprecatedAt: null,
  resourceStatus: ResourceStatusType.ENABLED,
  resourceStatusUpdatedAt: null,
  resourceStatusUpdatedBy: null,
  version: 1,
  createdAt: new Date(),
  updatedAt: new Date(),
  createdBy: null,
  updatedBy: null,
  metaData: null,
  tags: [],
};

function makeRepo() {
  const delegate = { findFirst: vi.fn(), findMany: vi.fn(), aggregate: vi.fn() };
  const unitOfWork = { getDatabaseService: () => ({ agent: delegate }) };
  return { delegate, repo: new AgentRepository(unitOfWork as any) };
}

describe('AgentRepository', () => {
  let delegate: ReturnType<typeof makeRepo>['delegate'];
  let repo: AgentRepository;
  beforeEach(() => ({ delegate, repo } = makeRepo()));

  it('findPublishedActiveBySlug filters PUBLISHED + isActive + ENABLED and lets the tenant-scope extension widen to [tenant, SYSTEM]', async () => {
    delegate.findMany.mockResolvedValue([row]);
    const found = await repo.findPublishedActiveBySlug('tenant-1', 'platform-summarization');
    expect(found?.slug).toBe('platform-summarization');
    const args = delegate.findMany.mock.calls[0][0];
    expect(args.where).toEqual({ slug: 'platform-summarization', status: 'PUBLISHED', isActive: true, resourceStatus: 'ENABLED' });
    // No explicit tenantId: `Agent` is SYSTEM-shared-read, and the extension REJECTS a
    // non-string tenantId filter — it widens the read to [caller, SYSTEM] itself.
    expect('tenantId' in args.where).toBe(false);
    expect(args.orderBy).toEqual([{ tenantId: 'desc' }]);
  });

  // TASK-890 L13 (OD-M) — `Agent` LEFT `SYSTEM_SHARED_READ_MODELS`. The by-slug read answers the
  // CALLER's row and nothing else: a SYSTEM row is not a fallback any more, it is the reference
  // the tenant's own clone was made FROM. The post-filter is defence in depth for a call made
  // with no CLS tenant, where the extension cannot filter at all.
  it('answers the caller`s row and drops every other tenant`s — SYSTEM included', async () => {
    const systemRow = { ...row, id: 'sys', tenantId: SYSTEM_TENANT_ID };
    const foreign = { ...row, id: 'foreign', tenantId: 'tenant-2' };
    delegate.findMany.mockResolvedValue([foreign, row, systemRow]);
    expect((await repo.findPublishedActiveBySlug('tenant-1', 'platform-summarization'))?.id).toBe('agent-1');
    delegate.findMany.mockResolvedValue([foreign, systemRow]);
    expect(await repo.findPublishedActiveBySlug('tenant-1', 'platform-summarization')).toBeNull();
    delegate.findMany.mockResolvedValue([foreign]);
    expect(await repo.findPublishedActiveBySlug('tenant-1', 'platform-summarization')).toBeNull();
  });

  it('findPublishedActiveBySlug returns null on a miss (404-over-403 is the caller`s job)', async () => {
    delegate.findMany.mockResolvedValue([]);
    expect(await repo.findPublishedActiveBySlug('tenant-1', 'nope')).toBeNull();
    delegate.findMany.mockRejectedValue(new DataNotFoundException('Agent', 'x'));
    expect(await repo.findPublishedActiveBySlug('tenant-1', 'nope')).toBeNull();
  });

  it('findPublishedActiveVisible lists the CALLER`s rows only, optionally filtered by task, one row per slug', async () => {
    const systemRow = { ...row, id: 'sys', tenantId: SYSTEM_TENANT_ID };
    const systemOnly = { ...row, id: 'sys-only', slug: 'platform-tts', task: AgentTask.TEXT_TO_SPEECH, tenantId: SYSTEM_TENANT_ID };
    delegate.findMany.mockResolvedValue([row, systemRow, systemOnly]);
    const rows = await repo.findPublishedActiveVisible('tenant-1');
    // The SYSTEM rows are absent: a tenant lists the agents it OWNS (each carrying
    // `sourceTenantId = SYSTEM` when it was provisioned from the platform library).
    expect(rows.map((r) => r.id)).toEqual(['agent-1']);
    await repo.findPublishedActiveVisible('tenant-1', AgentTask.TEXT_GENERATION);
    expect(delegate.findMany.mock.calls[1][0].where).toEqual({
      task: 'TEXT_GENERATION',
      status: 'PUBLISHED',
      isActive: true,
      resourceStatus: 'ENABLED',
    });
  });

  it('findMaxVersionNumber reads the aggregate from the tx client when given', async () => {
    const tx = { agent: { aggregate: vi.fn().mockResolvedValue({ _max: { versionNumber: 4 } }) } };
    expect(await repo.findMaxVersionNumber('tenant-1', 'x', tx)).toBe(4);
    expect(tx.agent.aggregate.mock.calls[0][0].where).toEqual({ tenantId: 'tenant-1', slug: 'x' });
    delegate.aggregate.mockResolvedValue({ _max: { versionNumber: null } });
    expect(await repo.findMaxVersionNumber('tenant-1', 'new')).toBe(0);
  });
});

describe('AgentAssignmentRepository.findForScope', () => {
  it('pins the exact tenant + scope + task and tolerates a miss as null', async () => {
    const delegate = { findFirst: vi.fn().mockRejectedValue(new DataNotFoundException('Agent', 'x')) };
    const repo = new AgentAssignmentRepository({ getDatabaseService: () => ({ agentAssignment: delegate }) } as any);
    expect(await repo.findForScope('tenant-1', PipelinePolicyScope.DEPARTMENT, 'dept-1', AgentTask.SPEECH_TO_TEXT)).toBeNull();
    expect(delegate.findFirst.mock.calls[0][0].where).toMatchObject({
      tenantId: 'tenant-1',
      scope: 'DEPARTMENT',
      scopeId: 'dept-1',
      task: 'SPEECH_TO_TEXT',
      resourceStatus: 'ENABLED',
    });
  });
});
