/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseDataModel, VirtualDbProperty } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class FedlUpdate extends BaseDataModel {
  public updateId: number;
  public clientId: string;
  public roundId: number;
  public weightHash: string;
  public numSamples: number;
  public metrics: JsonValue | null;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;
  @VirtualDbProperty()
  public Client: Models.FedlClient | undefined;
  @VirtualDbProperty()
  public Round: Models.FedlRound | undefined;

  constructor(data: FedlUpdate & BaseDataModel) {
    super(data);
    this.updateId = data.updateId;
    this.clientId = data.clientId;
    this.roundId = data.roundId;
    this.weightHash = data.weightHash;
    this.numSamples = data.numSamples;
    this.metrics = data.metrics;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
    this.Client = data.Client;
    this.Round = data.Round;
  }
}
