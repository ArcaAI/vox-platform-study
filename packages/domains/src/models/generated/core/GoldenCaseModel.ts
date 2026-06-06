/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class GoldenCase extends BaseTenantDataModel {
  public goldenSetId: string;
  public label: string | null;
  public transcript: string;
  public referenceNote: string;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;

  constructor(data: GoldenCase & BaseTenantDataModel) {
    super(data);
    this.goldenSetId = data.goldenSetId;
    this.label = data.label;
    this.transcript = data.transcript;
    this.referenceNote = data.referenceNote;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
  }
}
