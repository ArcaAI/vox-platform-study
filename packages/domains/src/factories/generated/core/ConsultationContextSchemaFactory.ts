/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BaseEntityFactoryCreateProps } from '../../../common';
import { ConsultationContextSchemaEntity, IConsultationContextSchemaEntity } from '../../../entities';
import * as Enums from '../../../enums';
import { generateId } from '../../../utils';

export interface CreateConsultationContextSchemaProps extends BaseEntityFactoryCreateProps {
  tenantId: IConsultationContextSchemaEntity['tenantId'];
  slug: IConsultationContextSchemaEntity['slug'];
  name: IConsultationContextSchemaEntity['name'];
  description?: IConsultationContextSchemaEntity['description'];
  scope?: IConsultationContextSchemaEntity['scope'];
  departmentId?: IConsultationContextSchemaEntity['departmentId'];
  status?: IConsultationContextSchemaEntity['status'];
  isDefault?: IConsultationContextSchemaEntity['isDefault'];
  sourceTemplateSlug?: IConsultationContextSchemaEntity['sourceTemplateSlug'];
  templateLocked?: IConsultationContextSchemaEntity['templateLocked'];

  createdAt?: IConsultationContextSchemaEntity['createdAt'];
  updatedAt?: IConsultationContextSchemaEntity['updatedAt'];
  createdBy?: IConsultationContextSchemaEntity['createdBy'];
  updatedBy?: IConsultationContextSchemaEntity['updatedBy'];
}

export class ConsultationContextSchemaFactory {
  /**
   * A new schema head. Always born DRAFT with NO pin — a schema becomes
   * servable only through `publish`, which is where the definition is
   * validated. `pinnedVersionNumber` is deliberately not a factory input:
   * nothing may point at a version that does not exist yet.
   */
  static CreateConsultationContextSchema(props: CreateConsultationContextSchemaProps): ConsultationContextSchemaEntity {
    const id = generateId();
    const now = new Date();

    return new ConsultationContextSchemaEntity({
      id,

      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy || null,

      tenantId: props.tenantId,
      slug: props.slug,
      name: props.name,
      description: props.description ?? null,
      scope: props.scope ?? Enums.ConsultationContextSchemaScope.TENANT,
      departmentId: props.departmentId ?? null,
      status: props.status ?? Enums.ConsultationContextSchemaStatus.DRAFT,
      pinnedVersionNumber: null,
      isDefault: props.isDefault ?? false,
      sourceTemplateSlug: props.sourceTemplateSlug ?? null,
      templateLocked: props.templateLocked ?? false,
    });
  }
}
