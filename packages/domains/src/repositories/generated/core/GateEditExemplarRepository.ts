import { Injectable } from '@nestjs/common';

import { Prisma } from '@arcaai/database';
import { DataNotFoundException } from '@arcaai/exceptions';

import { Repository } from '../../../common';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { GateEditExemplarEntity } from '../../../entities';
import { GateEditExemplarEntityMapper } from '../../../mappers';
import { GateEditExemplar } from '../../../models';

@Injectable()
export class GateEditExemplarRepository extends Repository<GateEditExemplarEntity, GateEditExemplar> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'gateEditExemplar', GateEditExemplarEntityMapper.getInstance());
  }

  /**
   * Idempotency guard for the mining job — one exemplar per consultation.
   * Returns `null` rather than throwing so the caller can treat "already mined"
   * as a no-op.
   */
  public async findByConsultation(
    tenantId: string,
    consultationId: string,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- mirrors the optional-tx signature used across hand-authored repositories
    tx?: Prisma.TransactionClient | any,
  ): Promise<GateEditExemplarEntity | null> {
    const where = { tenantId, consultationId };

    if (tx) {
      const model = await tx.gateEditExemplar.findFirst({ where });
      return model ? GateEditExemplarEntityMapper.getInstance().toDomainEntity(model) : null;
    }

    try {
      return await this.findFirst({ filters: where });
    } catch (err) {
      if (err instanceof DataNotFoundException) {
        return null;
      }
      throw err;
    }
  }

  /**
   * TASK-533 §3.4 — per-department few-shot exemplar retrieval: top-K by
   * recency for a given quality signal, scoped to the caller's tenant and
   * (optionally) department. Department is optional so a tenant with no
   * department context still gets tenant-level exemplars.
   */
  public async findTopForRetrieval(params: {
    tenantId: string;
    departmentId?: string | null;
    qualitySignal: string;
    limit: number;
  }): Promise<GateEditExemplarEntity[]> {
    const filters: Record<string, unknown> = {
      tenantId: params.tenantId,
      qualitySignal: params.qualitySignal,
    };

    if (params.departmentId) {
      filters.departmentId = params.departmentId;
    }

    return this.findAll({
      filters,
      limit: params.limit,
      page: 1,
      sort: [{ createdAt: 'desc' }],
    });
  }

  /**
   * TASK-533 §3.4 consumption (a) — eval regression-corpus export.
   *
   * Differs from {@link findTopForRetrieval} in one deliberate way: the quality
   * signal is OPTIONAL. Retrieval only ever shows the model clean approvals,
   * but a regression corpus wants the heavily-edited rows too — those are the
   * cases the model got wrong, and a corpus without them cannot detect a
   * regression.
   */
  public async findForCorpusExport(params: {
    tenantId: string;
    departmentId?: string | null;
    qualitySignal?: string;
    limit: number;
  }): Promise<GateEditExemplarEntity[]> {
    const filters: Record<string, unknown> = { tenantId: params.tenantId };

    if (params.departmentId) {
      filters.departmentId = params.departmentId;
    }
    if (params.qualitySignal) {
      filters.qualitySignal = params.qualitySignal;
    }

    return this.findAll({
      filters,
      limit: params.limit,
      page: 1,
      sort: [{ createdAt: 'desc' }],
    });
  }
}
