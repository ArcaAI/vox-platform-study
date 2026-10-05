import { Injectable } from '@nestjs/common';
import { ArgumentInvalidException } from '@arcaai/exceptions';
import {
  AiActivityKind,
  AiActivityRunEntity,
  AiActivityRunFactory,
  AiActivityRunRepository,
  ContextItemRepository,
  ContextItemType,
  NamedEntityRepository,
} from '@arcaai/domains';

import { ActivityRunMapper, asCount, asIdentifier, isRunKey } from './activity-run.mapper';
import { ActivityRunProducer, AiActivityRunInput, IActivityRunRecordReader, IAiActivityRunService } from './IAiActivityRunService';

/** Item types whose producer is the STT run named by `metaData.sttRunKey`. */
const STT_PRODUCED_TYPES: ReadonlySet<ContextItemType> = new Set([ContextItemType.TRANSCRIPT_SEGMENT, ContextItemType.FULL_TRANSCRIPT]);

type ItemRef = { tenantId: string; consultationId: string; contextItemId: string; versionNumber?: number };

/**
 * The AI activity run record: producer (`record`) and reader
 * (`findProducerOf`, `listForConsultation`).
 *
 * Append-only telemetry, like `AgentTrajectoryStep`: no sys-event (the record
 * IS the event) and no soft delete. Writes are idempotent upserts on `runKey`,
 * so a re-delivered producer converges on one row.
 */
@Injectable()
export class AiActivityRunService implements IAiActivityRunService, IActivityRunRecordReader {
  constructor(
    private readonly aiActivityRunRepository: AiActivityRunRepository,
    private readonly contextItemRepository: ContextItemRepository,
    private readonly namedEntityRepository: NamedEntityRepository,
  ) {}

  async record(input: AiActivityRunInput, tx?: unknown): Promise<void> {
    if (!isRunKey(input?.runKey)) {
      throw new ArgumentInvalidException('AiActivityRun runKey must be <producer>:<sessionId>:<runId>:<seq>');
    }
    const props = ActivityRunMapper.toCreateProps(input);
    if (!props) {
      throw new ArgumentInvalidException(`AiActivityRun needs a tenant, a known activity kind and status, and a start time (runKey ${input.runKey})`);
    }
    await this.aiActivityRunRepository.upsertByRunKey(AiActivityRunFactory.CreateAiActivityRun(props), tx);
  }

  /**
   * The run that produced an item version:
   *  - a transcript segment / full transcript → the STT run named by its
   *    `metaData.sttRunKey`;
   *  - a recap → the ledger run that produced `metaData.ledgerItemId` at
   *    `metaData.ledgerVersion`;
   * (both read from the item's plain `metaData`, which its writer restamps on
   * every rebuild — a version carries no metaData of its own on the domain);
   *  - an entity (a `NamedEntity` id) → the NER run of its parent item;
   *  - anything else → the run recorded against `(contextItemId, versionNumber)`,
   *    or the newest producing run when no version is given.
   * `null` when the item is not this consultation's, or nothing recorded it.
   */
  async findProducerOf(input: ItemRef): Promise<ActivityRunProducer | null> {
    const entity = await this.resolveProducer(input);
    return entity ? ActivityRunMapper.toProducer(entity) : null;
  }

  async listForConsultation(input: { tenantId: string; consultationId: string }): Promise<ActivityRunProducer[]> {
    const runs = await this.aiActivityRunRepository.findByConsultation(input.tenantId, input.consultationId);
    return runs.map((run) => ActivityRunMapper.toProducer(run));
  }

  private async resolveProducer(input: ItemRef): Promise<AiActivityRunEntity | null> {
    const item = await this.contextItemRepository.findByIdOrNull(input.contextItemId);
    if (!item) return this.resolveEntityProducer(input);
    if (item.tenantId !== input.tenantId || item.consultationId !== input.consultationId) return null;

    const versionNumber = input.versionNumber ?? null;
    const sttProduced = STT_PRODUCED_TYPES.has(item.type) || item.type === ContextItemType.TRANSCRIPT;
    const recap = item.type === ContextItemType.ENCOUNTER_RECAP;
    const meta = isRecord(item.metaData) ? item.metaData : {};

    const sttRunKey = asIdentifier(meta.sttRunKey);
    if (sttProduced && sttRunKey) return this.findOwnRun(sttRunKey, input.tenantId);
    if (STT_PRODUCED_TYPES.has(item.type)) return null;

    if (recap) {
      const ledgerItemId = asIdentifier(meta.ledgerItemId);
      if (!ledgerItemId) return null;
      return this.aiActivityRunRepository.findProducerOf({
        tenantId: input.tenantId,
        consultationId: input.consultationId,
        contextItemId: ledgerItemId,
        versionNumber: asCount(meta.ledgerVersion),
      });
    }

    return this.aiActivityRunRepository.findProducerOf({
      tenantId: input.tenantId,
      consultationId: input.consultationId,
      contextItemId: item.id,
      versionNumber,
    });
  }

  /** An id that is not a context item may be an entity: its producer is its parent item's NER run. */
  private async resolveEntityProducer(input: ItemRef): Promise<AiActivityRunEntity | null> {
    const entity = await this.namedEntityRepository.findByIdOrNull(input.contextItemId);
    if (!entity || entity.tenantId !== input.tenantId) return null;
    const parent = await this.contextItemRepository.findByIdOrNull(entity.contextItemId);
    if (!parent || parent.tenantId !== input.tenantId || parent.consultationId !== input.consultationId) return null;

    const [run] = await this.aiActivityRunRepository.findAll({
      where: { tenantId: input.tenantId, consultationId: input.consultationId, contextItemId: parent.id, activityKind: AiActivityKind.NER },
      sort: [{ startedAt: 'desc' }, { id: 'desc' }],
      page: 1,
      limit: 1,
    });
    return run ?? null;
  }

  private async findOwnRun(runKey: string, tenantId: string): Promise<AiActivityRunEntity | null> {
    const run = await this.aiActivityRunRepository.findByRunKey(runKey);
    return run && run.tenantId === tenantId ? run : null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
