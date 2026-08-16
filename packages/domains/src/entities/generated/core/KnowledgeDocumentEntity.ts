/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface IKnowledgeDocumentEntity extends IBaseTenantEntity {
  title: string;
  source: string;
  sourceType: string;
  mimeType: string;
  checksum: string;
  status: Enums.KnowledgeDocumentStatus;
  approvedBy?: string | null;
  approvedAt?: Date | null;
  ingestedAt?: Date | null;
  chunkCount: number;
}

export class KnowledgeDocumentEntity extends BaseTenantEntity {
  private _title: IKnowledgeDocumentEntity['title'];
  private _source: IKnowledgeDocumentEntity['source'];
  private _sourceType: IKnowledgeDocumentEntity['sourceType'];
  private _mimeType: IKnowledgeDocumentEntity['mimeType'];
  private _checksum: IKnowledgeDocumentEntity['checksum'];
  private _status: IKnowledgeDocumentEntity['status'];
  private _approvedBy?: IKnowledgeDocumentEntity['approvedBy'];
  private _approvedAt?: IKnowledgeDocumentEntity['approvedAt'];
  private _ingestedAt?: IKnowledgeDocumentEntity['ingestedAt'];
  private _chunkCount: IKnowledgeDocumentEntity['chunkCount'];

  constructor(init: IKnowledgeDocumentEntity) {
    super(init);
    this._title = init.title;
    this._source = init.source;
    this._sourceType = init.sourceType;
    this._mimeType = init.mimeType;
    this._checksum = init.checksum;
    this._status = init.status;
    this._approvedBy = init.approvedBy;
    this._approvedAt = init.approvedAt;
    this._ingestedAt = init.ingestedAt;
    this._chunkCount = init.chunkCount;
  }

  get title(): IKnowledgeDocumentEntity['title'] {
    return this._title;
  }

  set title(value: IKnowledgeDocumentEntity['title']) {
    this.setProperty('title', value);
  }

  get source(): IKnowledgeDocumentEntity['source'] {
    return this._source;
  }

  set source(value: IKnowledgeDocumentEntity['source']) {
    this.setProperty('source', value);
  }

  get sourceType(): IKnowledgeDocumentEntity['sourceType'] {
    return this._sourceType;
  }

  set sourceType(value: IKnowledgeDocumentEntity['sourceType']) {
    this.setProperty('sourceType', value);
  }

  get mimeType(): IKnowledgeDocumentEntity['mimeType'] {
    return this._mimeType;
  }

  set mimeType(value: IKnowledgeDocumentEntity['mimeType']) {
    this.setProperty('mimeType', value);
  }

  get checksum(): IKnowledgeDocumentEntity['checksum'] {
    return this._checksum;
  }

  set checksum(value: IKnowledgeDocumentEntity['checksum']) {
    this.setProperty('checksum', value);
  }

  get status(): IKnowledgeDocumentEntity['status'] {
    return this._status;
  }

  set status(value: IKnowledgeDocumentEntity['status']) {
    this.setProperty('status', value);
  }

  get approvedBy(): IKnowledgeDocumentEntity['approvedBy'] {
    return this._approvedBy;
  }

  set approvedBy(value: IKnowledgeDocumentEntity['approvedBy']) {
    this.setProperty('approvedBy', value);
  }

  get approvedAt(): IKnowledgeDocumentEntity['approvedAt'] {
    return this._approvedAt;
  }

  set approvedAt(value: IKnowledgeDocumentEntity['approvedAt']) {
    this.setProperty('approvedAt', value);
  }

  get ingestedAt(): IKnowledgeDocumentEntity['ingestedAt'] {
    return this._ingestedAt;
  }

  set ingestedAt(value: IKnowledgeDocumentEntity['ingestedAt']) {
    this.setProperty('ingestedAt', value);
  }

  get chunkCount(): IKnowledgeDocumentEntity['chunkCount'] {
    return this._chunkCount;
  }

  set chunkCount(value: IKnowledgeDocumentEntity['chunkCount']) {
    this.setProperty('chunkCount', value);
  }

  // ============================================
  // Custom Domain Methods
  // ============================================

  /** Whether the document has been approved for ingestion/retrieval. */
  get isApproved(): boolean {
    return this._status === Enums.KnowledgeDocumentStatus.APPROVED;
  }

  /** Whether the document is still a DRAFT (not yet approved). */
  get isDraft(): boolean {
    return this._status === Enums.KnowledgeDocumentStatus.DRAFT;
  }

  /** Whether the harness ingest job has completed for this document. */
  get isIngested(): boolean {
    return this._ingestedAt !== null && this._ingestedAt !== undefined;
  }

  /**
   * DRAFT -> APPROVED gate. Stamps the approver + approval time so the
   * ingestion job (and the WORM audit trail) can attribute the decision.
   */
  approve(approvedBy?: string | null): void {
    this.status = Enums.KnowledgeDocumentStatus.APPROVED;
    this.approvedAt = new Date();
    if (approvedBy) {
      this.approvedBy = approvedBy;
    }
  }

  /**
   * Record a completed ingestion: stamp `ingestedAt` and persist the number of
   * chunks the harness produced (mirrored as KnowledgeChunk rows).
   */
  markIngested(chunkCount: number): void {
    this.chunkCount = chunkCount;
    this.ingestedAt = new Date();
  }

  /**
   * Manual archive (TASK-728 — nothing auto-expires this content yet). A
   * soft-touch on the BUSINESS `status` axis, not the generic
   * `resourceStatus` soft-delete axis (`BaseEntity.archive()`, a DIFFERENT
   * method on a different axis — deliberately not overridden/reused here): an
   * ARCHIVED document stays listed and its chunks/vectors are untouched —
   * only `deleteDocument` removes them.
   */
  archiveContent(): void {
    this.status = Enums.KnowledgeDocumentStatus.ARCHIVED;
  }

  public override validate(): void {
    super.validate();
    if (!this._title || this._title.trim().length === 0) {
      throw new BusinessException('KnowledgeDocument title is required.');
    }
    if (!this._source || this._source.trim().length === 0) {
      throw new BusinessException('KnowledgeDocument source is required.');
    }
    if (!this._checksum || this._checksum.trim().length === 0) {
      throw new BusinessException('KnowledgeDocument checksum is required.');
    }
  }
}
