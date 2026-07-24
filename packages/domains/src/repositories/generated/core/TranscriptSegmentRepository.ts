import { Injectable } from '@nestjs/common';
import { Prisma } from '@arcaai/database';

import { Repository } from '../../../common';
import { removeNullValues } from '../../../common/removeNullValues';
import { TranscriptSegmentEntityMapper } from '../../../mappers';
import { TranscriptSegmentEntity } from '../../../entities';
import { TranscriptSegment } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';

/**
 * Segment-level transcript repository.
 *
 * `TranscriptSegment` is TENANT-SCOPED per-transcript annotation telemetry. Its
 * posture (mirroring NamedEntity / AudioRecording) is DELIBERATELY exempt from
 * SOFT-DELETE: the model is in MODELS_WITHOUT_SOFT_DELETE and has no
 * `resourceStatus` column — segments live and die with their parent transcript,
 * so `softDelete()`/`restore()` throw. Cross-tenant isolation is enforced
 * upstream by the shared tenant-scope `$extends` (whose drift guard lists
 * TranscriptSegment); every finder here is additionally scoped by `tenantId`.
 */
@Injectable()
export class TranscriptSegmentRepository extends Repository<TranscriptSegmentEntity, TranscriptSegment> {
  constructor(private readonly unitOfWorkService: CoreUnitOfWorkService) {
    super(unitOfWorkService, 'transcriptSegment', TranscriptSegmentEntityMapper.getInstance());
  }

  /**
   * All segments of a transcript context item, ordered by `idx` ascending
   * (append order = playback order).
   */
  async findByContextItem(tenantId: string, contextItemId: string): Promise<TranscriptSegmentEntity[]> {
    return this.findAll({
      filters: { tenantId, contextItemId },
      sort: [{ idx: 'asc' }],
    });
  }

  /**
   * Batch-insert transcript segments in ONE `createMany` round trip (F-14 —
   * the ingest path was previously one INSERT per segment, dozens–hundreds
   * per consult). Segment ids are pre-generated UUIDv7s from
   * `TranscriptSegmentFactory`, so `createMany` (which never returns rows) loses
   * nothing the caller needs. `skipDuplicates: true` matches the base
   * `Repository.createMany` default so a retried ingest cannot throw on a
   * unique-constraint collision. Accepts an optional transaction client so a
   * caller can compose this with other writes in one Postgres transaction —
   * mirrors the `tx?` contract on `Repository.create`/`updateWithVersion`.
   */
  async createMany(entities: TranscriptSegmentEntity[], tx?: Prisma.TransactionClient | any): Promise<{ count: number }> {
    if (entities.length === 0) {
      return { count: 0 };
    }
    const mapper = (this as any)._mapper;
    const data = entities.map((entity) => removeNullValues(mapper.toPersistence(entity)));
    const delegate = tx ? (tx as Record<string, any>)[this._modelName] : this.db;
    const result = await delegate.createMany({ data, skipDuplicates: true });
    return { count: result.count };
  }
}
