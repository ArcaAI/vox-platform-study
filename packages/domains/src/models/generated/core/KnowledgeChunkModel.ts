/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class KnowledgeChunk extends BaseTenantDataModel {
  public knowledgeDocumentId: string;
  public chunkIndex: number;
  public text: string;
  public tokenCount: number;
  public startOffset: number;
  public endOffset: number;
  public qdrantPointId: string;
  public embeddingModel: string;
  public embeddingDim: number;
  public status: string;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;

  constructor(data: KnowledgeChunk & BaseTenantDataModel) {
    super(data);
    this.knowledgeDocumentId = data.knowledgeDocumentId;
    this.chunkIndex = data.chunkIndex;
    this.text = data.text;
    this.tokenCount = data.tokenCount;
    this.startOffset = data.startOffset;
    this.endOffset = data.endOffset;
    this.qdrantPointId = data.qdrantPointId;
    this.embeddingModel = data.embeddingModel;
    this.embeddingDim = data.embeddingDim;
    this.status = data.status;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
  }
}
