/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel, VirtualDbProperty } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class KnowledgeDocument extends BaseTenantDataModel {
  public title: string;
  public source: string;
  public sourceType: string;
  public mimeType: string;
  public checksum: string;
  public status: Enums.KnowledgeDocumentStatus;
  public approvedBy: string | null;
  public approvedAt: Date | null;
  public ingestedAt: Date | null;
  public chunkCount: number;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;
  @VirtualDbProperty()
  public KnowledgeChunks: Models.KnowledgeChunk[] | undefined;

  constructor(data: KnowledgeDocument & BaseTenantDataModel) {
    super(data);
    this.title = data.title;
    this.source = data.source;
    this.sourceType = data.sourceType;
    this.mimeType = data.mimeType;
    this.checksum = data.checksum;
    this.status = data.status;
    this.approvedBy = data.approvedBy;
    this.approvedAt = data.approvedAt;
    this.ingestedAt = data.ingestedAt;
    this.chunkCount = data.chunkCount;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
    this.KnowledgeChunks = data.KnowledgeChunks;
  }
}
