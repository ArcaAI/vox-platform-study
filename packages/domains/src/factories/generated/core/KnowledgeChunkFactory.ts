/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { KnowledgeChunkEntity, IKnowledgeChunkEntity } from '../../../entities';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface CreateKnowledgeChunkProps extends BaseEntityFactoryCreateProps {
  knowledgeDocumentId: IKnowledgeChunkEntity['knowledgeDocumentId'];
  chunkIndex: IKnowledgeChunkEntity['chunkIndex'];
  text: IKnowledgeChunkEntity['text'];
  tokenCount: IKnowledgeChunkEntity['tokenCount'];
  startOffset: IKnowledgeChunkEntity['startOffset'];
  endOffset: IKnowledgeChunkEntity['endOffset'];
  qdrantPointId: IKnowledgeChunkEntity['qdrantPointId'];
  embeddingModel: IKnowledgeChunkEntity['embeddingModel'];
  embeddingDim: IKnowledgeChunkEntity['embeddingDim'];
  status: IKnowledgeChunkEntity['status'];
  tenantId: IKnowledgeChunkEntity['tenantId'];
  Tenant?: IKnowledgeChunkEntity['Tenant'];

  createdAt?: IKnowledgeChunkEntity['createdAt'];
  updatedAt?: IKnowledgeChunkEntity['updatedAt'];
  createdBy?: IKnowledgeChunkEntity['createdBy'];
  updatedBy?: IKnowledgeChunkEntity['updatedBy'];
}

export class KnowledgeChunkFactory {
  static CreateKnowledgeChunk(props: CreateKnowledgeChunkProps): KnowledgeChunkEntity {
    const id = generateId();
    const now = new Date();

    return new KnowledgeChunkEntity({
      id,

      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy || null,

      knowledgeDocumentId: props.knowledgeDocumentId,
      chunkIndex: props.chunkIndex,
      text: props.text,
      tokenCount: props.tokenCount,
      startOffset: props.startOffset,
      endOffset: props.endOffset,
      qdrantPointId: props.qdrantPointId,
      embeddingModel: props.embeddingModel,
      embeddingDim: props.embeddingDim,
      status: props.status,
      tenantId: props.tenantId,
      Tenant: props.Tenant ?? null,
    });
  }
}
