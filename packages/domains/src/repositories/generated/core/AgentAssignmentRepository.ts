import { Injectable } from '@nestjs/common';
import { SYSTEM_TENANT_ID } from '@arcaai/database';
import { DataNotFoundException } from '@arcaai/exceptions';

import { Repository } from '../../../common';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { AgentAssignmentEntity } from '../../../entities';
import { AgentTask, PipelinePolicyScope, ResourceStatusType } from '../../../enums';
import { AgentAssignmentEntityMapper } from '../../../mappers';
import { AgentAssignment } from '../../../models';

/**
 * `AgentAssignment` — WHICH agent serves a task for a scope (TASK-863).
 * Tenant-scoped, soft-deletable, SYSTEM-shared-read (the SYSTEM row is the
 * platform default the cascade ends on).
 */
@Injectable()
export class AgentAssignmentRepository extends Repository<AgentAssignmentEntity, AgentAssignment> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'agentAssignment', AgentAssignmentEntityMapper.getInstance());
  }

  /**
   * The single assignment row for one cascade tier, or `null` when that tier has
   * no opinion (the COMMON case — an unset tier inherits). `tenantId` is passed
   * explicitly and is a STRING (the caller's own id or SYSTEM), which the
   * shared-read extension accepts.
   */
  async findForScope(tenantId: string, scope: PipelinePolicyScope, scopeId: string | null, task: AgentTask): Promise<AgentAssignmentEntity | null> {
    return this.findFirstTolerant({ tenantId, scope, scopeId, task, resourceStatus: ResourceStatusType.ENABLED });
  }

  /** Every live assignment the caller holds (the matrix read), plus SYSTEM's platform defaults. */
  async findAllVisible(tenantId: string, task?: AgentTask): Promise<AgentAssignmentEntity[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- raw delegate shape isn't exposed through DomainModel typings.
    const rows: AgentAssignment[] = await (this.db as any).findMany({
      where: { ...(task ? { task } : {}), resourceStatus: ResourceStatusType.ENABLED },
      orderBy: [{ task: 'asc' }, { scope: 'asc' }, { scopeId: 'asc' }],
    });
    const mapper = AgentAssignmentEntityMapper.getInstance();
    return rows.filter((row) => row.tenantId === tenantId || row.tenantId === SYSTEM_TENANT_ID).map((row) => mapper.toDomainEntity(row));
  }

  private async findFirstTolerant(filters: Record<string, unknown>): Promise<AgentAssignmentEntity | null> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- DbFilters<AgentAssignment> would require importing the Prisma-generated model type here.
      const result = await this.findFirst({ filters: filters as any });
      return result ?? null;
    } catch (err) {
      if (err instanceof DataNotFoundException) {
        return null;
      }
      throw err;
    }
  }
}
