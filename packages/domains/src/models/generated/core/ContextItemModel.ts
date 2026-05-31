/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel } from '../../../common';
import * as Enums from '../../../enums';
import * as Models from './';

export class ContextItem extends BaseTenantDataModel {
  public consultationId: string;
  public type: Enums.ContextItemType;
  public source: Enums.ContextItemSource;
  public currentVersionNumber: number;
  public content: string | null;
  public mediaId: string | null;
  public dnaWritingStyleId: string | null;
  public qdrantSynced: boolean;
  public qdrantSyncedAt: Date | null;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;

  constructor(data: ContextItem & BaseTenantDataModel) {
    super(data);
    this.consultationId = data.consultationId;
    this.type = data.type;
    this.source = data.source ?? Enums.ContextItemSource.USER;
    this.currentVersionNumber = data.currentVersionNumber ?? 1;
    this.content = data.content;
    this.mediaId = data.mediaId;
    this.dnaWritingStyleId = data.dnaWritingStyleId;
    this.qdrantSynced = data.qdrantSynced ?? false;
    this.qdrantSyncedAt = data.qdrantSyncedAt;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
  }
}
