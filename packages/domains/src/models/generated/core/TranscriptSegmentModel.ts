/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

/**
 * Persistence model for a segment-level slice of a TRANSCRIPT context item
 *. Extends `BaseTenantDataModel` (id / tenantId / _version /
 * _metadata / createdBy / updatedBy / createdAt / updatedAt). Deliberately has
 * NO `resourceStatus*` columns — segments live and die with their parent
 * transcript (like NamedEntity / AudioRecording), so the model is listed in
 * MODELS_WITHOUT_SOFT_DELETE. Stores ONLY non-PHI structural metadata: the
 * ordinal, time span, speaker label, and the [charStart, charEnd) character
 * offsets into the parent transcript's (encrypted) content — never the segment
 * text itself (recoverable via the offsets).
 */
export class TranscriptSegment extends BaseTenantDataModel {
  public contextItemId: string;
  public idx: number;
  public t0Ms: number | null;
  public t1Ms: number | null;
  public speaker: string | null;
  public charStart: number | null;
  public charEnd: number | null;

  constructor(data: TranscriptSegment & BaseTenantDataModel) {
    super(data);
    this.contextItemId = data.contextItemId;
    this.idx = data.idx;
    this.t0Ms = data.t0Ms;
    this.t1Ms = data.t1Ms;
    this.speaker = data.speaker;
    this.charStart = data.charStart;
    this.charEnd = data.charEnd;
  }
}
