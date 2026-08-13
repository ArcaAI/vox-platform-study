import { Injectable } from '@nestjs/common';
import { DataNotFoundException } from '@arcaai/exceptions';

import { Repository } from '../../../common';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { DepartmentAgentVersionEntity } from '../../../entities';
import { DepartmentAgentVersionEntityMapper } from '../../../mappers';
import { DepartmentAgentVersion } from '../../../models';

/**
 * Immutable loop-configuration snapshots of a `DepartmentAgent`.
 *
 * Listed in `MODELS_WITHOUT_SOFT_DELETE`: the table has no `resourceStatus`
 * column, so `softDelete`/`restore` throw and reads must NOT filter on it. A
 * consultation loop pinned to version N has to resolve version N
 * forever, which is precisely why retraction is not available here.
 *
 * `update` is never called on this model. Every write creates a NEW row.
 */
@Injectable()
export class DepartmentAgentVersionRepository extends Repository<DepartmentAgentVersionEntity, DepartmentAgentVersion> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'departmentAgentVersion', DepartmentAgentVersionEntityMapper.getInstance());
  }

  /** One exact snapshot, or null. */
  async findByAgentAndVersionNumber(agentId: string, versionNumber: number): Promise<DepartmentAgentVersionEntity | null> {
    return this.findFirstTolerant({ agentId, versionNumber });
  }

  /**
   * The highest-numbered snapshot for an agent — the comparison basis for the
   * no-op-write guard and for allocating the next `versionNumber`. Null before
   * the first write.
   */
  async findLatestForAgent(agentId: string): Promise<DepartmentAgentVersionEntity | null> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- DbFilters<DepartmentAgentVersion> would require importing the Prisma-generated model type here.
    const rows = await this.findAll({ filters: { agentId } as any, sort: [{ versionNumber: 'desc' }], limit: 1, page: 1 });
    return rows[0] ?? null;
  }

  /** Every snapshot of an agent, newest first. */
  async findAllForAgent(agentId: string): Promise<DepartmentAgentVersionEntity[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see findLatestForAgent.
    return this.findAll({ filters: { agentId } as any, sort: [{ versionNumber: 'desc' }] });
  }

  private async findFirstTolerant(filters: Record<string, unknown>): Promise<DepartmentAgentVersionEntity | null> {
    try {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see findLatestForAgent.
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
