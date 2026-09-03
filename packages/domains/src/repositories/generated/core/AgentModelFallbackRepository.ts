import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { AgentModelFallbackEntity } from '../../../entities';
import { ResourceStatusType } from '../../../enums';
import { AgentModelFallbackEntityMapper } from '../../../mappers';
import { AgentModelFallback } from '../../../models';

/** `AgentModelFallback` — the ordered fallback chain of one agent VERSION row (TASK-863). */
@Injectable()
export class AgentModelFallbackRepository extends Repository<AgentModelFallbackEntity, AgentModelFallback> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'agentModelFallback', AgentModelFallbackEntityMapper.getInstance());
  }

  /** The chain, in priority order. */
  async findByAgentId(agentId: string, tx?: unknown): Promise<AgentModelFallbackEntity[]> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- tx delegate shape isn't exposed through DomainModel typings.
    const model: any = tx ? (tx as Record<string, any>)[this._modelName] : this.db;
    const rows: AgentModelFallback[] = await model.findMany({
      where: { agentId, resourceStatus: ResourceStatusType.ENABLED },
      orderBy: [{ priority: 'asc' }],
    });
    const mapper = AgentModelFallbackEntityMapper.getInstance();
    return rows.map((row) => mapper.toDomainEntity(row));
  }

  /**
   * Replace-wholesale support for a DRAFT agent: the chain is re-authored as a
   * unit and `(agentId, priority)` is unique, so soft-deleting the old links
   * would collide with the new ones. A hard delete is sanctioned HERE ONLY
   * because the DB trigger refuses it for a PUBLISHED/DEPRECATED agent — the
   * chain of a published version is part of its immutable bytes.
   */
  async deleteAllForAgent(agentId: string, tx?: unknown): Promise<number> {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- see findByAgentId.
    const model: any = tx ? (tx as Record<string, any>)[this._modelName] : this.db;
    const result = await model.deleteMany({ where: { agentId } });
    return result?.count ?? 0;
  }
}
