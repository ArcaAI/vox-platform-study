/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity, Secret } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

/**
 * A single ordered segment (diarized turn / VAD segment) of a TRANSCRIPT
 * context item (TASK-519).
 *
 * INTENTIONAL posture (mirrors NamedEntity / AudioRecording, differs from the
 * standard clinical models):
 *   - NO soft-delete: the entity is listed in MODELS_WITHOUT_SOFT_DELETE and
 *     the table carries no `resourceStatus` column; `softDelete()`/`restore()`
 *     throw for this repository. Segments live and die with their parent
 *     transcript.
 *   - NON-PHI ONLY: stores the ordinal, time span, speaker label and the
 *     [charStart, charEnd) offsets into the parent transcript's (encrypted)
 *     content — never the segment text (recoverable via the offsets), so this
 *     table adds no new plaintext-PHI surface.
 * `_version` (OCC) + `_metadata` + standard audit fields are retained so the
 * row round-trips through the shared BaseTenantEntity / Repository machinery.
 */
export interface ITranscriptSegmentEntity extends IBaseTenantEntity {
  contextItemId: string;
  idx: number;
  t0Ms?: number | null;
  t1Ms?: number | null;
  speaker?: string | null;
  charStart?: number | null;
  charEnd?: number | null;
}

export class TranscriptSegmentEntity extends BaseTenantEntity {
  private _contextItemId: ITranscriptSegmentEntity['contextItemId'];
  private _idx: ITranscriptSegmentEntity['idx'];
  private _t0Ms?: ITranscriptSegmentEntity['t0Ms'];
  private _t1Ms?: ITranscriptSegmentEntity['t1Ms'];
  private _speaker?: ITranscriptSegmentEntity['speaker'];
  private _charStart?: ITranscriptSegmentEntity['charStart'];
  private _charEnd?: ITranscriptSegmentEntity['charEnd'];

  constructor(init: ITranscriptSegmentEntity) {
    super(init);
    this._contextItemId = init.contextItemId;
    this._idx = init.idx;
    this._t0Ms = init.t0Ms;
    this._t1Ms = init.t1Ms;
    this._speaker = init.speaker;
    this._charStart = init.charStart;
    this._charEnd = init.charEnd;
  }

  get contextItemId(): ITranscriptSegmentEntity['contextItemId'] {
    return this._contextItemId;
  }

  set contextItemId(value: ITranscriptSegmentEntity['contextItemId']) {
    this.setProperty('contextItemId', value);
  }

  get idx(): ITranscriptSegmentEntity['idx'] {
    return this._idx;
  }

  set idx(value: ITranscriptSegmentEntity['idx']) {
    this.setProperty('idx', value);
  }

  get t0Ms(): ITranscriptSegmentEntity['t0Ms'] {
    return this._t0Ms;
  }

  set t0Ms(value: ITranscriptSegmentEntity['t0Ms']) {
    this.setProperty('t0Ms', value);
  }

  get t1Ms(): ITranscriptSegmentEntity['t1Ms'] {
    return this._t1Ms;
  }

  set t1Ms(value: ITranscriptSegmentEntity['t1Ms']) {
    this.setProperty('t1Ms', value);
  }

  get speaker(): ITranscriptSegmentEntity['speaker'] {
    return this._speaker;
  }

  set speaker(value: ITranscriptSegmentEntity['speaker']) {
    this.setProperty('speaker', value);
  }

  get charStart(): ITranscriptSegmentEntity['charStart'] {
    return this._charStart;
  }

  set charStart(value: ITranscriptSegmentEntity['charStart']) {
    this.setProperty('charStart', value);
  }

  get charEnd(): ITranscriptSegmentEntity['charEnd'] {
    return this._charEnd;
  }

  set charEnd(value: ITranscriptSegmentEntity['charEnd']) {
    this.setProperty('charEnd', value);
  }

  public override validate(): void {
    super.validate();
    if (!this._contextItemId || this._contextItemId.trim().length === 0) {
      throw new BusinessException('TranscriptSegment contextItemId is required.');
    }
    if (this._idx === undefined || this._idx === null || this._idx < 0) {
      throw new BusinessException('TranscriptSegment idx must be a non-negative integer.');
    }
  }
}
