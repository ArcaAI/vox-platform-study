import { Injectable } from '@nestjs/common';

import { Repository } from '../../../common';
import { TranscriptSegmentEntityMapper } from '../../../mappers';
import { TranscriptSegmentEntity } from '../../../entities';
import { TranscriptSegment } from '../../../models';
import { CoreUnitOfWorkService } from '../../../common/unitsOfWork/core';

/**
 * Segment-level transcript repository (TASK-519).
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
}
