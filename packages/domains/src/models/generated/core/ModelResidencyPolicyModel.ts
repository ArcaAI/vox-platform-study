/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel, VirtualDbProperty } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class ModelResidencyPolicy extends BaseTenantDataModel {
  public aiModelId: string;
  public service: string;
  public class: Enums.ModelResidencyClass;
  public idleTtlSeconds: number | null;
  public priority: number;
  public maxInstances: number;
  public preferredDevice: string | null;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;
  @VirtualDbProperty()
  public AiModel: Models.AiModel | undefined;

  constructor(data: ModelResidencyPolicy & BaseTenantDataModel) {
    super(data);
    this.aiModelId = data.aiModelId;
    this.service = data.service;
    this.class = data.class;
    this.idleTtlSeconds = data.idleTtlSeconds;
    this.priority = data.priority;
    this.maxInstances = data.maxInstances;
    this.preferredDevice = data.preferredDevice;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
    this.AiModel = data.AiModel;
  }
}
