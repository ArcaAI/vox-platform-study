/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseDataModel, VirtualDbProperty } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class FedlClient extends BaseDataModel {
  public clientId: string;
  public lastUpdate: Date | null;
  public totalUpdates: number;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;
  @VirtualDbProperty()
  public Updates: Models.FedlUpdate[] | undefined;

  constructor(data: FedlClient & BaseDataModel) {
    super(data);
    this.clientId = data.clientId;
    this.lastUpdate = data.lastUpdate;
    this.totalUpdates = data.totalUpdates;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
    this.Updates = data.Updates;
  }
}
