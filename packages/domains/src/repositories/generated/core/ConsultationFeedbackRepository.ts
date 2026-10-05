import { Injectable } from '@nestjs/common';
import { Prisma } from '@arcaai/database';
import { ArgumentInvalidException } from '@arcaai/exceptions';

import { Repository } from '../../../common';
import { removeNullValues } from '../../../common/removeNullValues';
import { ConsultationFeedbackEntityMapper } from '../../../mappers';
import { ConsultationFeedbackEntity } from '../../../entities';
import { ConsultationFeedback } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';
import { FeedbackRating, FeedbackTargetKind } from '../../../enums';

/** Keyset position of a feedback row: `(createdAt, id)`, newest first. */
export interface FeedbackCursor {
  createdAt: Date;
  id: string;
}

/** Filters + paging for {@link ConsultationFeedbackRepository.listCursor}. */
export interface FeedbackListOptions {
  limit: number;
  targetKind?: FeedbackTargetKind;
  contextItemId?: string;
  /** Include superseded facts too (default: latest only). */
  includeHistory?: boolean;
  after?: FeedbackCursor;
}

/** One aggregated rollup row (dimensions + counts), PHI-free. */
export interface FeedbackRollupAggregate {
  day: Date;
  targetKind: FeedbackTargetKind;
  agentSlug: string;
  agentVersion: number;
  modelName: string;
  promptVersion: string;
  sectionKey: string;
  entityLabel: string;
  reasonCode: string;
  upCount: number;
  downCount: number;
  clearedCount: number;
  commentCount: number;
  correctionCount: number;
  reasonedCount: number;
}

/** The columns the rollup reads — dimensions and markers only, never comment ciphertext or targets. */
const ROLLUP_SELECT = {
  createdAt: true,
  targetKind: true,
  provAgentSlug: true,
  provAgentVersion: true,
  provModelName: true,
  provPromptVersion: true,
  targetSectionKey: true,
  entityLabel: true,
  rating: true,
  reasonCodes: true,
  keyVersion: true,
  correctionContextItemId: true,
} as const;

type RollupSourceRow = {
  createdAt: Date;
  targetKind: FeedbackTargetKind | null;
  provAgentSlug: string | null;
  provAgentVersion: number | null;
  provModelName: string | null;
  provPromptVersion: string | null;
  targetSectionKey: string | null;
  entityLabel: string | null;
  rating: FeedbackRating | null;
  reasonCodes: string[];
  keyVersion: number | null;
  correctionContextItemId: string | null;
};

function utcDay(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

/**
 * Append-only clinician feedback. A rated fact supersedes the actor's previous
 * rated fact on the same `targetKey` (one latest per (tenant, actor,
 * targetKey) — the partial unique index `ConsultationFeedback_latest_uq`);
 * nothing is ever deleted. No soft delete, no `_version`.
 */
@Injectable()
export class ConsultationFeedbackRepository extends Repository<ConsultationFeedbackEntity, ConsultationFeedback> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'consultationFeedback', ConsultationFeedbackEntityMapper.getInstance());
  }

  /**
   * Insert `entity`; when it is a rated fact on a target, first flip the
   * actor's current latest rated row on that `targetKey` to `isLatest =
   * false` and link it as `supersedesId`. Must run in the caller's
   * transaction (`tx` is required) so the flip and the insert commit together.
   */
  async appendWithSupersede(
    entity: ConsultationFeedbackEntity,
    tx: Prisma.TransactionClient | any,
  ): Promise<{ saved: ConsultationFeedbackEntity; superseded: ConsultationFeedbackEntity | null }> {
    if (!tx) {
      throw new ArgumentInvalidException('appendWithSupersede must run inside a transaction');
    }
    const delegate = (tx as Record<string, any>).consultationFeedback;
    const mapper = (this as any)._mapper as ConsultationFeedbackEntityMapper;

    let superseded: ConsultationFeedbackEntity | null = null;
    if (entity.rating && entity.targetKey) {
      const prior = await delegate.findFirst({
        where: { tenantId: entity.tenantId, actorUserId: entity.actorUserId, targetKey: entity.targetKey, isLatest: true, rating: { not: null } },
        orderBy: [{ createdAt: 'desc' }],
      });
      if (prior) {
        await delegate.updateMany({ where: { id: prior.id, isLatest: true }, data: { isLatest: false } });
        entity.supersedesId = prior.id;
        superseded = mapper.toDomainEntity({ ...prior, isLatest: false });
      }
    }

    const model = await delegate.create({ data: removeNullValues(mapper.toPersistence(entity)) });
    return { saved: mapper.toDomainEntity(model), superseded };
  }

  /** The actor's current rated fact on `targetKey`, or `null`. */
  async findLatestByActorTarget(tenantId: string, actorUserId: string, targetKey: string): Promise<ConsultationFeedbackEntity | null> {
    const model = await (this as any).db.findFirst({
      where: { tenantId, actorUserId, targetKey, isLatest: true, rating: { not: null } },
      orderBy: [{ createdAt: 'desc' }],
    });
    return model ? (this as any)._mapper.toDomainEntity(model) : null;
  }

  /**
   * One keyset page of the consultation's feedback, newest first by
   * `(createdAt, id)`. Latest facts only unless `includeHistory`.
   */
  async listCursor(
    consultationId: string,
    options: FeedbackListOptions,
  ): Promise<{ items: ConsultationFeedbackEntity[]; next: FeedbackCursor | null }> {
    const where: Record<string, unknown> = { consultationId };
    if (!options.includeHistory) where.isLatest = true;
    if (options.targetKind) where.targetKind = options.targetKind;
    if (options.contextItemId) where.targetContextItemId = options.contextItemId;
    if (options.after) {
      where.OR = [{ createdAt: { lt: options.after.createdAt } }, { createdAt: options.after.createdAt, id: { lt: options.after.id } }];
    }

    const models = await (this as any).db.findMany({
      where,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: options.limit + 1,
    });
    const page = models.slice(0, options.limit);
    const items: ConsultationFeedbackEntity[] = page.map((model: ConsultationFeedback) => (this as any)._mapper.toDomainEntity(model));
    const last = page[page.length - 1];
    const next = models.length > options.limit && last ? { createdAt: last.createdAt, id: last.id } : null;
    return { items, next };
  }

  /**
   * Aggregate every feedback EVENT of the tenant in `[from, to)` into rollup
   * rows per UTC day and dimension: the `''` reason row carries the rating,
   * comment and correction counts; one row per reason code carries
   * `reasonedCount`. Consultation-level facts (no `targetKind`) are not part
   * of the rollup. Reads dimensions only — never comment ciphertext or ids.
   * A stored comment is detected by `keyVersion` (only the comment is
   * encrypted on this table).
   */
  async aggregateEvents(tenantId: string, from: Date, to: Date): Promise<FeedbackRollupAggregate[]> {
    const rows: RollupSourceRow[] = await (this as any).db.findMany({
      where: { tenantId, createdAt: { gte: from, lt: to } },
      select: ROLLUP_SELECT,
    });

    const buckets = new Map<string, FeedbackRollupAggregate>();
    const bucket = (row: RollupSourceRow, reasonCode: string): FeedbackRollupAggregate => {
      const dims = {
        day: utcDay(row.createdAt),
        targetKind: row.targetKind as FeedbackTargetKind,
        agentSlug: row.provAgentSlug ?? '',
        agentVersion: row.provAgentVersion ?? 0,
        modelName: row.provModelName ?? '',
        promptVersion: row.provPromptVersion ?? '',
        sectionKey: row.targetSectionKey ?? '',
        entityLabel: row.entityLabel ?? '',
        reasonCode,
      };
      const key = JSON.stringify(dims);
      let agg = buckets.get(key);
      if (!agg) {
        agg = { ...dims, upCount: 0, downCount: 0, clearedCount: 0, commentCount: 0, correctionCount: 0, reasonedCount: 0 };
        buckets.set(key, agg);
      }
      return agg;
    };

    for (const row of rows) {
      if (!row.targetKind) continue;
      const base = bucket(row, '');
      if (row.rating === FeedbackRating.UP) base.upCount += 1;
      if (row.rating === FeedbackRating.DOWN) base.downCount += 1;
      if (row.rating === FeedbackRating.CLEARED) base.clearedCount += 1;
      if (row.keyVersion !== null && row.keyVersion !== undefined) base.commentCount += 1;
      if (row.correctionContextItemId) base.correctionCount += 1;
      for (const code of new Set(row.reasonCodes ?? [])) {
        bucket(row, code).reasonedCount += 1;
      }
    }
    return [...buckets.values()];
  }
}
