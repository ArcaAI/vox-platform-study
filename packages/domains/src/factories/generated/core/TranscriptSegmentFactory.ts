/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { TranscriptSegmentEntity, ITranscriptSegmentEntity } from '../../../entities';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface CreateTranscriptSegmentProps extends BaseEntityFactoryCreateProps {
  tenantId: ITranscriptSegmentEntity['tenantId'];
  contextItemId: ITranscriptSegmentEntity['contextItemId'];
  idx: ITranscriptSegmentEntity['idx'];
  t0Ms?: ITranscriptSegmentEntity['t0Ms'];
  t1Ms?: ITranscriptSegmentEntity['t1Ms'];
  speaker?: ITranscriptSegmentEntity['speaker'];
  charStart?: ITranscriptSegmentEntity['charStart'];
  charEnd?: ITranscriptSegmentEntity['charEnd'];
  Tenant?: ITranscriptSegmentEntity['Tenant'];

  createdAt?: ITranscriptSegmentEntity['createdAt'];
  createdBy?: ITranscriptSegmentEntity['createdBy'];
}

export class TranscriptSegmentFactory {
  /**
   * Build one ordered transcript segment. `id` is a time-sortable UUIDv7 and
   * `_version`/timestamps follow the house convention; the caller assigns
   * `idx` (per-transcript ordinal, 0-based). Persisting segments does NOT
   * broadcast its own sys-event — the parent transcript's ResourceCreated
   * event already covers the ingest (segments are children of it).
   */
  static CreateTranscriptSegment(props: CreateTranscriptSegmentProps): TranscriptSegmentEntity {
    const id = generateId();
    const now = props.createdAt || new Date();

    return new TranscriptSegmentEntity({
      id,

      createdAt: now,
      updatedAt: now,
      createdBy: props.createdBy ?? null,
      updatedBy: null,

      tenantId: props.tenantId,
      contextItemId: props.contextItemId,
      idx: props.idx,
      t0Ms: props.t0Ms ?? null,
      t1Ms: props.t1Ms ?? null,
      speaker: props.speaker ?? null,
      charStart: props.charStart ?? null,
      charEnd: props.charEnd ?? null,
      Tenant: props.Tenant ?? null,
    });
  }
}
