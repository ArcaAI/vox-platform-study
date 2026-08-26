/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BaseEntityFactoryCreateProps } from '../../../common';
import { DocumentTemplateVersionEntity, IDocumentTemplateVersionEntity } from '../../../entities';
import { generateId } from '../../../utils';

export interface CreateDocumentTemplateVersionProps extends BaseEntityFactoryCreateProps {
  tenantId: IDocumentTemplateVersionEntity['tenantId'];
  templateId: IDocumentTemplateVersionEntity['templateId'];
  versionNumber: IDocumentTemplateVersionEntity['versionNumber'];
  shape: IDocumentTemplateVersionEntity['shape'];
  compiled: IDocumentTemplateVersionEntity['compiled'];
  compilerVersion: IDocumentTemplateVersionEntity['compilerVersion'];
  checksum: IDocumentTemplateVersionEntity['checksum'];
  changeReason?: IDocumentTemplateVersionEntity['changeReason'];

  createdAt?: IDocumentTemplateVersionEntity['createdAt'];
  createdBy?: IDocumentTemplateVersionEntity['createdBy'];
}

export class DocumentTemplateVersionFactory {
  /**
   * One immutable published snapshot. Both `compiled` and `checksum` are
   * supplied by the caller rather than derived here, for the same reason
   * `ConsultationContextSchemaVersionFactory` takes its checksum: the SAME
   * compilation and the SAME canonicalisation that decided "is this republish
   * a no-op" must be the ones persisted. A second implementation in a factory
   * would be a second source of truth, and the two would eventually disagree
   * about whether a published clinical template had changed.
   *
   * No `updatedAt`/`updatedBy`: the row is never updated (the mapper strips
   * them, and a DB trigger refuses the write outright — OD-13).
   */
  static CreateDocumentTemplateVersion(props: CreateDocumentTemplateVersionProps): DocumentTemplateVersionEntity {
    const id = generateId();
    const now = new Date();

    return new DocumentTemplateVersionEntity({
      id,

      createdAt: props.createdAt || now,
      updatedAt: props.createdAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: null,

      tenantId: props.tenantId,
      templateId: props.templateId,
      versionNumber: props.versionNumber,
      shape: props.shape,
      compiled: props.compiled,
      compilerVersion: props.compilerVersion,
      checksum: props.checksum,
      changeReason: props.changeReason ?? null,
    });
  }
}
