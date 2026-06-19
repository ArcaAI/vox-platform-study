/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel, VirtualDbProperty } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class KnowledgeChunk extends BaseTenantDataModel {
  public knowledgeDocumentId: string;
  public chunkIndex: number;
  // TASK-369 Phase 6 — plaintext text column DROPPED; persistence is
  // ciphertext-only. The entity keeps `text` as a transient field repopulated by
  // repository decrypt-on-read.
  public tokenCount: number;
  public startOffset: number;
  public endOffset: number;
  // TASK-369 Phase 3C — Vault-Transit ciphertext column + shared key version.
  public encryptedText: Uint8Array | null;
  public keyVersion: number | null;
  public qdrantPointId: string;
  public embeddingModel: string;
  public embeddingDim: number;
  public status: string;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;
  @VirtualDbProperty()
  public KnowledgeDocument: Models.KnowledgeDocument | undefined;

  constructor(data: KnowledgeChunk & BaseTenantDataModel) {
    super(data);
    this.knowledgeDocumentId = data.knowledgeDocumentId;
    this.chunkIndex = data.chunkIndex;
    this.tokenCount = data.tokenCount;
    this.startOffset = data.startOffset;
    this.endOffset = data.endOffset;
    this.encryptedText = data.encryptedText;
    this.keyVersion = data.keyVersion;
    this.qdrantPointId = data.qdrantPointId;
    this.embeddingModel = data.embeddingModel;
    this.embeddingDim = data.embeddingDim;
    this.status = data.status;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
    this.KnowledgeDocument = data.KnowledgeDocument;
  }
}
