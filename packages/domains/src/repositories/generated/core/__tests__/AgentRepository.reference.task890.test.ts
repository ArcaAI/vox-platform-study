/**
 * TASK-890 L13 step iii — the REFERENCE-LIBRARY reads.
 *
 * `Agent` leaves `SYSTEM_SHARED_READ_MODELS` at step v, so every read that must still see the
 * SYSTEM reference set says so EXPLICITLY on the UNSCOPED base client — the
 * `WorkflowDefinitionRepository.findCloneSource` / `findSystemTemplates` pattern (§2.7 #23),
 * copied line for line. These reads are consumed ONLY by the reference-set provisioning service
 * and the super-admin library branch of `AgentService.clone`; nothing on a runtime path.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { SYSTEM_TENANT_ID } from '@arcaai/database';
import { AgentRepository } from '../AgentRepository';
import { AgentTask, ResourceStatusType, WorkflowDefinitionStatus } from '../../../../enums';

const row = {
  id: 'agent-1',
  tenantId: SYSTEM_TENANT_ID,
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
  contextSchemaId: null,
  contextSchemaVersionNumber: null,
  sourceAgentId: null,
  sourceTenantId: null,
  sourceSlug: null,
  sourceVersionNumber: null,
};

function makeRepo() {
  // The SCOPED delegate must never be touched by a reference read.
  const scoped = { findFirst: vi.fn(), findMany: vi.fn(), aggregate: vi.fn() };
  const unitOfWork = { getDatabaseService: () => ({ agent: scoped }) };
  const base = { agent: { findFirst: vi.fn(), findMany: vi.fn() } };
  return { scoped, base, repo: new AgentRepository(unitOfWork as any) };
}

describe('AgentRepository reference reads (TASK-890)', () => {
  let scoped: ReturnType<typeof makeRepo>['scoped'];
  let base: ReturnType<typeof makeRepo>['base'];
  let repo: AgentRepository;
  beforeEach(() => ({ scoped, base, repo } = makeRepo()));

  it('findSystemReferences reads the SUPPLIED unscoped client with an EXPLICIT SYSTEM pin and the live predicate', async () => {
    base.agent.findMany.mockResolvedValue([row]);
    const rows = await repo.findSystemReferences(base);
    expect(rows.map((r) => r.slug)).toEqual(['platform-summarization']);
    expect(scoped.findMany).not.toHaveBeenCalled();
    expect(base.agent.findMany.mock.calls[0][0].where).toEqual({
      tenantId: SYSTEM_TENANT_ID,
      status: WorkflowDefinitionStatus.PUBLISHED,
      isActive: true,
      resourceStatus: ResourceStatusType.ENABLED,
    });
  });

  it('findSystemReferences filters by task when asked, and answers [] when the library is empty', async () => {
    base.agent.findMany.mockResolvedValue([]);
    expect(await repo.findSystemReferences(base, AgentTask.TEXT_TO_SPEECH)).toEqual([]);
    expect(base.agent.findMany.mock.calls[0][0].where.task).toBe(AgentTask.TEXT_TO_SPEECH);
  });

  it('findSystemReferenceBySlug pins SYSTEM + the live predicate and answers null on a miss', async () => {
    base.agent.findFirst.mockResolvedValue(null);
    expect(await repo.findSystemReferenceBySlug('nope', base)).toBeNull();
    base.agent.findFirst.mockResolvedValue(row);
    expect((await repo.findSystemReferenceBySlug('platform-summarization', base))?.id).toBe('agent-1');
    expect(base.agent.findFirst.mock.calls[1][0].where).toEqual({
      slug: 'platform-summarization',
      tenantId: SYSTEM_TENANT_ID,
      status: WorkflowDefinitionStatus.PUBLISHED,
      isActive: true,
      resourceStatus: ResourceStatusType.ENABLED,
    });
  });
});
