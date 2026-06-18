/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseDataModel } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class FedlModelVersion extends BaseDataModel {
  public versionId: number;
  public weightHash: string;
  public isCurrent: boolean;
  public mlflowRunId: string | null;
  public mlflowVersion: string | null;
  public mlflowArtifactUri: string | null;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;

  constructor(data: FedlModelVersion & BaseDataModel) {
    super(data);
    this.versionId = data.versionId;
    this.weightHash = data.weightHash;
    this.isCurrent = data.isCurrent;
    this.mlflowRunId = data.mlflowRunId;
    this.mlflowVersion = data.mlflowVersion;
    this.mlflowArtifactUri = data.mlflowArtifactUri;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
  }
}
