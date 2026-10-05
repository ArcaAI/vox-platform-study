/**
 * TASK-1036 OD-21 — "used by N published workflows".
 *
 * A pinned agent version keeps running after it is deprecated, so Deprecate warns with the count
 * of the caller's PUBLISHED/DEPRECATED workflow versions whose compiled config pins that version.
 * Tenant-scoped: an unknown version, or another tenant's lineage, is a 404.
 */
import { describe, expect, it, vi } from 'vitest';
import { NotFoundException } from '@nestjs/common';
import { ResourceStatusType, WorkflowDefinitionStatus } from '@arcaai/domains';
import { AgentUsageService } from '../agent-usage.service';

const TENANT = '50000000-0000-0000-0000-000000000000';

function workflow(slug: string, versionNumber: number, status: WorkflowDefinitionStatus, isActive: boolean, compiledConfig: unknown) {
  return { slug, versionNumber, status, isActive, compiledConfig, resourceStatus: ResourceStatusType.ENABLED };
}
function agentNode(slug: string, versionNumber?: number) {
  return { nodeId: `n-${slug}`, type: 'core.agent', config: { agentRef: { slug, ...(versionNumber ? { versionNumber } : {}) } } };
}
const stages = (...nodes: unknown[]) => ({ stages: [{ stageIndex: 0, nodes }] });

function makeService(rows: ReturnType<typeof workflow>[], agentVersions = [{ versionNumber: 2 }, { versionNumber: 3 }]) {
  const agentRepository = { findAllVersionsBySlug: vi.fn(async () => agentVersions) };
  const workflowRepository = {
    findAll: vi.fn(async ({ filters }: { filters: { status: string } }) => rows.filter((row) => row.status === filters.status)),
  };
  const cls = { get: vi.fn(() => TENANT) };
  const service = new AgentUsageService(agentRepository as never, workflowRepository as never, cls as never);
  return { service, agentRepository, workflowRepository };
}

describe('AgentUsageService.usage', () => {
  it('lists published + deprecated workflows whose compiled config pins that exact agent version', async () => {
    const { service, workflowRepository } = makeService([
      workflow('intake', 4, WorkflowDefinitionStatus.PUBLISHED, true, stages(agentNode('scribe', 2))),
      workflow('intake', 3, WorkflowDefinitionStatus.DEPRECATED, false, stages(agentNode('scribe', 2))),
      workflow('other', 1, WorkflowDefinitionStatus.PUBLISHED, true, stages(agentNode('scribe', 3))),
      workflow('unrelated', 1, WorkflowDefinitionStatus.PUBLISHED, true, stages(agentNode('triage', 2))),
      workflow('unpinned', 1, WorkflowDefinitionStatus.PUBLISHED, true, stages(agentNode('scribe'))),
    ]);

    const usage = await service.usage('scribe', 2);

    expect(usage).toEqual({
      publishedWorkflows: [
        { slug: 'intake', versionNumber: 3, isActive: false },
        { slug: 'intake', versionNumber: 4, isActive: true },
      ],
      count: 2,
    });
    const filters = workflowRepository.findAll.mock.calls.map((call) => call[0].filters);
    expect(filters.every((filter) => filter.tenantId === TENANT)).toBe(true);
  });

  it('finds an agent node inside a loop body', async () => {
    const config = { stages: [], loops: [{ nodeId: 'l', body: stages(agentNode('scribe', 2)) }] };
    const { service } = makeService([workflow('looped', 1, WorkflowDefinitionStatus.PUBLISHED, true, config)]);
    expect((await service.usage('scribe', 2)).count).toBe(1);
  });

  it('answers 0 for a version nothing pins', async () => {
    const { service } = makeService([]);
    expect(await service.usage('scribe', 3)).toEqual({ publishedWorkflows: [], count: 0 });
  });

  it('is a 404 for a version the caller tenant does not own (cross-tenant / unknown)', async () => {
    const { service } = makeService([], []);
    await expect(service.usage('scribe', 9)).rejects.toBeInstanceOf(NotFoundException);
  });
});
