/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseDataModel, VirtualDbProperty } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class FedlRound extends BaseDataModel {
  public roundId: number;
  public status: Enums.FedlRoundStatus;
  public startedAt: Date;
  public completedAt: Date | null;
  public updatesCount: number;
  public minUpdatesRequired: number;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;
  @VirtualDbProperty()
  public Updates: Models.FedlUpdate[] | undefined;

  constructor(data: FedlRound & BaseDataModel) {
    super(data);
    this.roundId = data.roundId;
    this.status = data.status;
    this.startedAt = data.startedAt;
    this.completedAt = data.completedAt;
    this.updatesCount = data.updatesCount;
    this.minUpdatesRequired = data.minUpdatesRequired;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
    this.Updates = data.Updates;
  }
}
