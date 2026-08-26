/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BaseEntityFactoryCreateProps } from '../../../common';
import { DocumentTemplateEntity, IDocumentTemplateEntity } from '../../../entities';
import * as Enums from '../../../enums';
import { generateId } from '../../../utils';

export interface CreateDocumentTemplateProps extends BaseEntityFactoryCreateProps {
  tenantId: IDocumentTemplateEntity['tenantId'];
  slug: IDocumentTemplateEntity['slug'];
  name: IDocumentTemplateEntity['name'];
  description?: IDocumentTemplateEntity['description'];
  status?: IDocumentTemplateEntity['status'];
  isDefault?: IDocumentTemplateEntity['isDefault'];
  sourceTemplateSlug?: IDocumentTemplateEntity['sourceTemplateSlug'];
  templateLocked?: IDocumentTemplateEntity['templateLocked'];

  createdAt?: IDocumentTemplateEntity['createdAt'];
  updatedAt?: IDocumentTemplateEntity['updatedAt'];
  createdBy?: IDocumentTemplateEntity['createdBy'];
  updatedBy?: IDocumentTemplateEntity['updatedBy'];
}

export class DocumentTemplateFactory {
  /**
   * A new template head. Always born DRAFT with NO pin — a template becomes
   * servable only through `publish`, which is where the shape is validated and
   * compiled. `pinnedVersionNumber` is deliberately not a factory input:
   * nothing may point at a version that does not exist yet.
   */
  static CreateDocumentTemplate(props: CreateDocumentTemplateProps): DocumentTemplateEntity {
    const id = generateId();
    const now = new Date();

    return new DocumentTemplateEntity({
      id,

      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy || null,

      tenantId: props.tenantId,
      slug: props.slug,
      name: props.name,
      description: props.description ?? null,
      status: props.status ?? Enums.DocumentTemplateStatus.DRAFT,
      pinnedVersionNumber: null,
      isDefault: props.isDefault ?? false,
      sourceTemplateSlug: props.sourceTemplateSlug ?? null,
      templateLocked: props.templateLocked ?? false,
    });
  }
}
