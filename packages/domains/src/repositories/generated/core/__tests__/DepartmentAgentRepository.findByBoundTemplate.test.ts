/**
 * DepartmentAgentRepository.findByBoundTemplate.
 *
 * The eval promotion gate used to find bound agents with
 * `findAll({ filters: { tenantId, promptTemplateId } })`, which sees only the
 * BASE binding. An agent can bind a template SOLELY through a
 * capability column, and such an agent would have escaped the gate at approve
 * time. This lookup ORs across all five binding columns.
 */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { describe, it, expect, vi, beforeEach } from 'vitest';

import { DepartmentAgentRepository } from '../DepartmentAgentRepository';
import { ResourceStatusType } from '../../../../enums';

describe('DepartmentAgentRepository — findByBoundTemplate', () => {
  let findMany: ReturnType<typeof vi.fn>;
  let repo: DepartmentAgentRepository;

  beforeEach(() => {
    findMany = vi.fn().mockResolvedValue([]);
    const unitOfWork = { getDatabaseService: () => ({ departmentAgent: { findMany } }) };
    repo = new DepartmentAgentRepository(unitOfWork as never);
  });

  it('ORs across the base binding AND all four capability columns, tenant-scoped and ENABLED-only', async () => {
    await repo.findByBoundTemplate('tenant-1', 'tpl-42');

    const where = findMany.mock.calls[0][0].where;
    expect(where.tenantId).toBe('tenant-1');
    expect(where.resourceStatus).toBe(ResourceStatusType.ENABLED);
    expect(where.OR).toEqual([
      { promptTemplateId: 'tpl-42' },
      { newPatientTemplateId: 'tpl-42' },
      { revisitTemplateId: 'tpl-42' },
      { preSummaryTemplateId: 'tpl-42' },
      { livePromptTemplateId: 'tpl-42' },
    ]);
  });

  it('returns the mapped agents', async () => {
    findMany.mockResolvedValue([
      {
        id: 'agent-1',
        tenantId: 'tenant-1',
        departmentId: 'dept-1',
        name: 'Surgery',
        slug: 'surg-default',
        description: null,
        promptTemplateId: 'tpl-base',
        pinnedVersionNumber: null,
        dnaStylePolicy: 'INHERIT',
        harnessOverrides: null,
        goldenSetId: null,
        newPatientTemplateId: null,
        // Bound ONLY through a capability column — exactly the case the old
        // base-binding-only lookup missed.
        revisitTemplateId: 'tpl-42',
        preSummaryTemplateId: null,
        livePromptTemplateId: null,
        toolConfig: null,
        llmOverrides: null,
        isDefault: true,
        sourceAgentTemplateSlug: null,
        templateLocked: false,
        tags: [],
        resourceStatus: ResourceStatusType.ENABLED,
        version: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        createdBy: null,
        updatedBy: null,
        resourceStatusUpdatedAt: null,
        resourceStatusUpdatedBy: null,
        metaData: null,
      },
    ]);

    const agents = await repo.findByBoundTemplate('tenant-1', 'tpl-42');

    expect(agents).toHaveLength(1);
    expect(agents[0].id).toBe('agent-1');
    expect(agents[0].revisitTemplateId).toBe('tpl-42');
  });
});
