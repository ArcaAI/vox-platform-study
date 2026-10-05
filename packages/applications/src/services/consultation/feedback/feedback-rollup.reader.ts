import { BadRequestException, Injectable } from '@nestjs/common';
import { ClsService } from 'nestjs-cls';
import { ConsultationFeedbackDailyRollupRepository } from '@arcaai/domains';

import { IActiveUserContext } from '../../../interfaces';
import {
  FeedbackRollupDimension,
  FeedbackRollupFilters,
  FeedbackRollupResponse,
  FeedbackRollupRow,
  IFeedbackRollupReader,
} from './IFeedbackRollupReader';

export const FEEDBACK_ROLLUP_MAX_ROWS = 5000;
/** Hard bound on source rows read; the grouped output is capped separately. */
const MAX_SOURCE_ROWS = 100_000;
const DEFAULT_RANGE_DAYS = 30;
const MS_PER_DAY = 24 * 60 * 60 * 1000;

const COUNTERS = [
  ['up', 'upCount'],
  ['down', 'downCount'],
  ['cleared', 'clearedCount'],
  ['comments', 'commentCount'],
  ['corrections', 'correctionCount'],
  ['reasoned', 'reasonedCount'],
] as const;

/** `''` / version `0` are the rollup's "not applicable" sentinels; surface them as null. */
function dimensionValue(row: Record<string, any>, dim: FeedbackRollupDimension): string | null {
  switch (dim) {
    case 'day':
      return (row.day as Date).toISOString().slice(0, 10);
    case 'agentVersion':
      return row.agentVersion ? String(row.agentVersion) : null;
    case 'model':
      return row.modelName || null;
    case 'promptVersion':
      return row.promptVersion || null;
    case 'section':
      return row.sectionKey || null;
    case 'entityLabel':
      return row.entityLabel || null;
    case 'reason':
      return row.reasonCode || null;
    case 'targetKind':
      return row.targetKind || null;
  }
}

function utcDay(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
}

/** Tenant-scoped admin read of the daily feedback rollup. Ids, dimensions and counts only. */
@Injectable()
export class FeedbackRollupReadService implements IFeedbackRollupReader {
  constructor(
    private readonly rollupRepository: ConsultationFeedbackDailyRollupRepository,
    private readonly clsService: ClsService<IActiveUserContext>,
  ) {}

  async query(filters: FeedbackRollupFilters): Promise<FeedbackRollupResponse> {
    const tenantId = this.clsService.get('tenantId');
    if (!tenantId) throw new BadRequestException('A tenant context is required.');

    const to = filters.to ? utcDay(new Date(filters.to)) : utcDay(new Date());
    const from = filters.from ? utcDay(new Date(filters.from)) : new Date(to.getTime() - DEFAULT_RANGE_DAYS * MS_PER_DAY);

    const entities = await this.rollupRepository.findForReport(
      tenantId,
      from,
      to,
      { agentSlug: filters.agentSlug, modelName: filters.modelName },
      MAX_SOURCE_ROWS,
    );

    const groups = new Map<string, FeedbackRollupRow>();
    let truncated = entities.length >= MAX_SOURCE_ROWS;
    for (const entity of entities) {
      const dimensions: Record<string, string | null> = {};
      for (const dim of filters.groupBy) dimensions[dim] = dimensionValue(entity as any, dim);
      const key = JSON.stringify(filters.groupBy.map((d) => dimensions[d]));
      let group = groups.get(key);
      if (!group) {
        if (groups.size >= FEEDBACK_ROLLUP_MAX_ROWS) {
          truncated = true;
          continue;
        }
        group = { dimensions, up: 0, down: 0, cleared: 0, comments: 0, corrections: 0, reasoned: 0 };
        groups.set(key, group);
      }
      for (const [out, column] of COUNTERS) group[out] += (entity as any)[column] ?? 0;
    }
    return { rows: [...groups.values()], truncated };
  }
}
