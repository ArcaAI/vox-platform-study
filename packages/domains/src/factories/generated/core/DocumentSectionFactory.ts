/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { DocumentSectionEntity, IDocumentSectionEntity } from '../../../entities';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface CreateDocumentSectionProps extends BaseEntityFactoryCreateProps {
  tenantId: IDocumentSectionEntity['tenantId'];
  consultationId: IDocumentSectionEntity['consultationId'];
  documentKey: IDocumentSectionEntity['documentKey'];
  sectionKey: IDocumentSectionEntity['sectionKey'];
  title: IDocumentSectionEntity['title'];
  idx: IDocumentSectionEntity['idx'];
  /** Defaults to EMPTY — "nothing extracted yet", which is a normal state, not an error. */
  state?: IDocumentSectionEntity['state'];
  content?: IDocumentSectionEntity['content'];
  annotations?: IDocumentSectionEntity['annotations'];
  provenance?: IDocumentSectionEntity['provenance'];
  documentTemplateVersionId?: IDocumentSectionEntity['documentTemplateVersionId'];

  createdAt?: IDocumentSectionEntity['createdAt'];
  createdBy?: IDocumentSectionEntity['createdBy'];
}

export class DocumentSectionFactory {
  /**
   * Build one document section. `id` is a time-sortable UUIDv7 and `_version`
   * follows the house convention (DB-owned, never written by a mapper).
   *
   * `revision` starts at 0 and is advanced by the entity's own write methods —
   * it is the CONTENT counter a client uses to discard an out-of-order
   * `section.patch`, and is deliberately distinct from `_version`, which is the
   * OCC token the repository compare-and-sets.
   */
  static CreateDocumentSection(props: CreateDocumentSectionProps): DocumentSectionEntity {
    const id = generateId();
    const now = props.createdAt || new Date();

    return new DocumentSectionEntity({
      id,

      createdAt: now,
      updatedAt: now,
      createdBy: props.createdBy ?? null,
      updatedBy: null,

      tenantId: props.tenantId,
      consultationId: props.consultationId,
      documentKey: props.documentKey,
      sectionKey: props.sectionKey,
      title: props.title,
      idx: props.idx,
      state: props.state ?? Enums.DocumentSectionState.EMPTY,
      revision: 0,
      content: props.content ?? null,
      encryptedContent: null,
      contentKeyVersion: null,
      annotations: props.annotations ?? null,
      provenance: props.provenance ?? null,
      documentTemplateVersionId: props.documentTemplateVersionId ?? null,
      confirmedAt: null,
      confirmedBy: null,
      lockedAt: null,
      Consultation: null,
    });
  }
}
