/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface IKnowledgeChunkEntity extends IBaseTenantEntity {
  knowledgeDocumentId: string;
  chunkIndex: number;
  text: string;
  tokenCount: number;
  startOffset: number;
  endOffset: number;
  qdrantPointId: string;
  embeddingModel: string;
  embeddingDim: number;
  status: string;
}

export class KnowledgeChunkEntity extends BaseTenantEntity {
  private _knowledgeDocumentId: IKnowledgeChunkEntity['knowledgeDocumentId'];
  private _chunkIndex: IKnowledgeChunkEntity['chunkIndex'];
  private _text: IKnowledgeChunkEntity['text'];
  private _tokenCount: IKnowledgeChunkEntity['tokenCount'];
  private _startOffset: IKnowledgeChunkEntity['startOffset'];
  private _endOffset: IKnowledgeChunkEntity['endOffset'];
  private _qdrantPointId: IKnowledgeChunkEntity['qdrantPointId'];
  private _embeddingModel: IKnowledgeChunkEntity['embeddingModel'];
  private _embeddingDim: IKnowledgeChunkEntity['embeddingDim'];
  private _status: IKnowledgeChunkEntity['status'];

  constructor(init: IKnowledgeChunkEntity) {
    super(init);
    this._knowledgeDocumentId = init.knowledgeDocumentId;
    this._chunkIndex = init.chunkIndex;
    this._text = init.text;
    this._tokenCount = init.tokenCount;
    this._startOffset = init.startOffset;
    this._endOffset = init.endOffset;
    this._qdrantPointId = init.qdrantPointId;
    this._embeddingModel = init.embeddingModel;
    this._embeddingDim = init.embeddingDim;
    this._status = init.status;
  }

  get knowledgeDocumentId(): IKnowledgeChunkEntity['knowledgeDocumentId'] {
    return this._knowledgeDocumentId;
  }

  set knowledgeDocumentId(value: IKnowledgeChunkEntity['knowledgeDocumentId']) {
    this.setProperty('knowledgeDocumentId', value);
  }

  get chunkIndex(): IKnowledgeChunkEntity['chunkIndex'] {
    return this._chunkIndex;
  }

  set chunkIndex(value: IKnowledgeChunkEntity['chunkIndex']) {
    this.setProperty('chunkIndex', value);
  }

  get text(): IKnowledgeChunkEntity['text'] {
    return this._text;
  }

  set text(value: IKnowledgeChunkEntity['text']) {
    this.setProperty('text', value);
  }

  get tokenCount(): IKnowledgeChunkEntity['tokenCount'] {
    return this._tokenCount;
  }

  set tokenCount(value: IKnowledgeChunkEntity['tokenCount']) {
    this.setProperty('tokenCount', value);
  }

  get startOffset(): IKnowledgeChunkEntity['startOffset'] {
    return this._startOffset;
  }

  set startOffset(value: IKnowledgeChunkEntity['startOffset']) {
    this.setProperty('startOffset', value);
  }

  get endOffset(): IKnowledgeChunkEntity['endOffset'] {
    return this._endOffset;
  }

  set endOffset(value: IKnowledgeChunkEntity['endOffset']) {
    this.setProperty('endOffset', value);
  }

  get qdrantPointId(): IKnowledgeChunkEntity['qdrantPointId'] {
    return this._qdrantPointId;
  }

  set qdrantPointId(value: IKnowledgeChunkEntity['qdrantPointId']) {
    this.setProperty('qdrantPointId', value);
  }

  get embeddingModel(): IKnowledgeChunkEntity['embeddingModel'] {
    return this._embeddingModel;
  }

  set embeddingModel(value: IKnowledgeChunkEntity['embeddingModel']) {
    this.setProperty('embeddingModel', value);
  }

  get embeddingDim(): IKnowledgeChunkEntity['embeddingDim'] {
    return this._embeddingDim;
  }

  set embeddingDim(value: IKnowledgeChunkEntity['embeddingDim']) {
    this.setProperty('embeddingDim', value);
  }

  get status(): IKnowledgeChunkEntity['status'] {
    return this._status;
  }

  set status(value: IKnowledgeChunkEntity['status']) {
    this.setProperty('status', value);
  }

  public override validate(): void {
    super.validate();
    if (!this._knowledgeDocumentId) {
      throw new BusinessException('KnowledgeChunk knowledgeDocumentId is required.');
    }
    if (!this._text || this._text.trim().length === 0) {
      throw new BusinessException('KnowledgeChunk text is required.');
    }
    if (!this._qdrantPointId || this._qdrantPointId.trim().length === 0) {
      throw new BusinessException('KnowledgeChunk qdrantPointId is required.');
    }
  }
}
