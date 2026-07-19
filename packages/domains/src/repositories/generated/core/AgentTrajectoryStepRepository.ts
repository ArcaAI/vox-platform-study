import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { AgentTrajectoryStepEntityMapper } from '../../../mappers';
import { AgentTrajectoryStepEntity } from '../../../entities';
import { AgentTrajectoryStep } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { AgentSessionKind } from '../../../enums';

/**
 * One distinct working session as returned by
 * {@link AgentTrajectoryStepRepository.listSessionSummaries} (TASK-510 S2).
 *
 * Aggregated at the DB via Prisma `groupBy` — callers must NOT re-scan every
 * step row in memory.
 */
export interface AgentTrajectorySessionSummary {
  sessionId: string;
  runId: string;
  sessionKind: string;
  consultationId: string | null;
  stepCount: number;
  firstStepAt: Date;
  lastStepAt: Date;
}

/** Optional filters for {@link AgentTrajectoryStepRepository.listSessionSummaries}. */
export interface ListSessionSummariesFilters {
  consultationId?: string;
  sessionKind?: AgentSessionKind | string;
  createdAt?: { gte?: Date; lte?: Date };
}

/**
 * Ordered session-trajectory repository (TASK-510 Phase 2A).
 *
 * `AgentTrajectoryStep` is TENANT-SCOPED operational telemetry. Its posture is
 * DELIBERATELY exempt from two platform conventions:
 *   - SOFT-DELETE: the model is in MODELS_WITHOUT_SOFT_DELETE and has no
 *     `resourceStatus` column — rows are hard-pruned by a retention job, so
 *     `softDelete()`/`restore()` throw (see `Repository.supportsSoftDelete`).
 *   - SYS-EVENTS: writes emit NO sys-event — the trajectory IS the event
 *     stream, so a per-step sys-event would be circular. Steps are appended via
 *     the inherited `create`; there is no update surface beyond the base OCC
 *     `updateWithVersion`.
 * Cross-tenant isolation is enforced upstream by the shared tenant-scope
 * `$extends` (tenant-scope.ts, whose drift guard lists AgentTrajectoryStep);
 * every finder here is additionally scoped by an explicit `tenantId` filter.
 */
@Injectable()
export class AgentTrajectoryStepRepository extends Repository<AgentTrajectoryStepEntity, AgentTrajectoryStep> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'agentTrajectoryStep', AgentTrajectoryStepEntityMapper.getInstance());
  }

  /**
   * All steps for a session, ordered by `seq` ascending (append order). When
   * `runId` is supplied the read narrows to that run's per-run seq stream
   * (Temporal runId); otherwise it returns the whole session.
   */
  async findBySession(tenantId: string, sessionId: string, runId?: string): Promise<AgentTrajectoryStepEntity[]> {
    const filters = runId !== undefined ? { tenantId, sessionId, runId } : { tenantId, sessionId };
    return this.findAll({
      filters,
      sort: [{ seq: 'asc' }],
    });
  }

  /**
   * The trajectory timeline for a single consultation, ordered by `seq`.
   */
  async findByConsultation(tenantId: string, consultationId: string): Promise<AgentTrajectoryStepEntity[]> {
    return this.findAll({
      filters: { tenantId, consultationId },
      sort: [{ seq: 'asc' }],
    });
  }

  /**
   * Distinct sessions for a tenant (TASK-510 S2), aggregated in the DB.
   *
   * Groups by `(sessionKind, sessionId, runId)` via Prisma `groupBy`:
   *   - `stepCount` ← `_count._all`
   *   - `firstStepAt` ← `_min.startedAt`
   *   - `lastStepAt` ← max(`_max.endedAt`, `_max.startedAt`) so null `endedAt`
   *     rows still contribute their start (matches the pre-S2 in-memory coalesce)
   *   - `consultationId` ← `_max.consultationId` (nullable; null when every
   *     step in the group has none)
   *
   * Filtering (consultation / kind / createdAt range) is pushed into the
   * `where` clause so the DB never materializes unmatched step rows.
   */
  async listSessionSummaries(
    tenantId: string,
    filters: ListSessionSummariesFilters = {},
  ): Promise<AgentTrajectorySessionSummary[]> {
    const where: Record<string, unknown> = { tenantId };
    if (filters.consultationId) where.consultationId = filters.consultationId;
    if (filters.sessionKind) where.sessionKind = filters.sessionKind;
    if (filters.createdAt) where.createdAt = filters.createdAt;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const results = await (this as any).db.groupBy({
      by: ['sessionKind', 'sessionId', 'runId'],
      where,
      _count: { _all: true },
      _min: { startedAt: true },
      _max: { startedAt: true, endedAt: true, consultationId: true },
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return results.map((r: any) => {
      const firstStepAt = toDate(r._min.startedAt);
      const maxStarted = toDate(r._max.startedAt);
      const maxEnded = r._max.endedAt ? toDate(r._max.endedAt) : null;
      const lastStepAt =
        maxEnded && maxEnded.getTime() > maxStarted.getTime() ? maxEnded : maxStarted;
      return {
        sessionId: r.sessionId as string,
        runId: (r.runId ?? '') as string,
        sessionKind: String(r.sessionKind),
        consultationId: (r._max.consultationId ?? null) as string | null,
        stepCount: r._count._all as number,
        firstStepAt,
        lastStepAt,
      };
    });
  }
}

function toDate(value: Date | string): Date {
  return value instanceof Date ? value : new Date(value);
}
