import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, vi } from 'vitest';
import { DataNotFoundException } from '@arcaai/exceptions';
import { PipelinePolicyScope } from '@arcaai/domains';
import { AgentAssignmentService } from '../agent-assignment.service';

type Internals = Record<string, (...args: unknown[]) => Promise<unknown>>;

const build = (repos: { assignmentRepository?: unknown; departmentRepository?: unknown }) => {
  const logger = { warn: vi.fn(), error: vi.fn() };
  const service = Object.create(AgentAssignmentService.prototype) as Record<string, unknown>;
  Object.assign(service, repos, { logger, requireTenant: () => 'tenant-1' });
  return { service: service as unknown as Internals, logger };
};

describe('AgentAssignmentService.loadOwned', () => {
  it('a missing assignment is still a 404', async () => {
    const { service, logger } = build({
      assignmentRepository: { findById: vi.fn().mockRejectedValue(new DataNotFoundException('AgentAssignment', 'a1')) },
    });

    await expect(service.loadOwned('a1')).rejects.toBeInstanceOf(NotFoundException);
    expect(logger.error).not.toHaveBeenCalled();
  });

  it('a database outage is logged and rethrown as itself — not disguised as a 404', async () => {
    const outage = new Error('ECONNRESET');
    const { service, logger } = build({ assignmentRepository: { findById: vi.fn().mockRejectedValue(outage) } });

    await expect(service.loadOwned('a1')).rejects.toBe(outage);
    expect(logger.error).toHaveBeenCalledWith(expect.objectContaining({ error: outage, assignmentId: 'a1', tenantId: 'tenant-1' }));
  });
});

describe('AgentAssignmentService.assertDepartmentInTenant', () => {
  it('an unknown department is still a 404, an outage is rethrown', async () => {
    const outage = new Error('ECONNRESET');
    const miss = build({ departmentRepository: { findById: vi.fn().mockRejectedValue(new DataNotFoundException('Department', 'd1')) } });
    await expect(miss.service.assertDepartmentInTenant(PipelinePolicyScope.DEPARTMENT, 'd1')).rejects.toBeInstanceOf(NotFoundException);

    const down = build({ departmentRepository: { findById: vi.fn().mockRejectedValue(outage) } });
    await expect(down.service.assertDepartmentInTenant(PipelinePolicyScope.DEPARTMENT, 'd1')).rejects.toBe(outage);
  });
});
