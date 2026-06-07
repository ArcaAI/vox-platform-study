/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { KnowledgeDocumentEntity, IKnowledgeDocumentEntity } from '../../../entities';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface CreateKnowledgeDocumentProps extends BaseEntityFactoryCreateProps {
  title: IKnowledgeDocumentEntity['title'];
  source: IKnowledgeDocumentEntity['source'];
  sourceType: IKnowledgeDocumentEntity['sourceType'];
  mimeType: IKnowledgeDocumentEntity['mimeType'];
  checksum: IKnowledgeDocumentEntity['checksum'];
  status?: IKnowledgeDocumentEntity['status'];
  approvedBy?: IKnowledgeDocumentEntity['approvedBy'];
  approvedAt?: IKnowledgeDocumentEntity['approvedAt'];
  ingestedAt?: IKnowledgeDocumentEntity['ingestedAt'];
  chunkCount?: IKnowledgeDocumentEntity['chunkCount'];
  tenantId: IKnowledgeDocumentEntity['tenantId'];
  Tenant?: IKnowledgeDocumentEntity['Tenant'];

  createdAt?: IKnowledgeDocumentEntity['createdAt'];
  updatedAt?: IKnowledgeDocumentEntity['updatedAt'];
  createdBy?: IKnowledgeDocumentEntity['createdBy'];
  updatedBy?: IKnowledgeDocumentEntity['updatedBy'];
}

export class KnowledgeDocumentFactory {
  static CreateKnowledgeDocument(props: CreateKnowledgeDocumentProps): KnowledgeDocumentEntity {
    const id = generateId();
    const now = new Date();

    return new KnowledgeDocumentEntity({
      id,

      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy || null,

      title: props.title,
      source: props.source,
      sourceType: props.sourceType,
      mimeType: props.mimeType,
      checksum: props.checksum,
      status: props.status ?? Enums.KnowledgeDocumentStatus.DRAFT,
      approvedBy: props.approvedBy ?? null,
      approvedAt: props.approvedAt ?? null,
      ingestedAt: props.ingestedAt ?? null,
      chunkCount: props.chunkCount ?? 0,
      tenantId: props.tenantId,
      Tenant: props.Tenant ?? null,
    });
  }
}
