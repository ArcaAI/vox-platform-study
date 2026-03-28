/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { PromptTemplateEntity } from '../../../entities/generated/core/PromptTemplateEntity';

export interface CreatePromptTemplateProps extends BaseEntityFactoryCreateProps {
  name?: string | null;
  description?: string | null;
  content?: string | null;
  category?: string | null;
  variables?: Record<string, unknown> | null;
  currentVersionNumber?: number | null;
  departmentId?: string | null;
  tags?: string[] | null;
  tenantId?: string;
  createdAt?: Date;
  updatedAt?: Date;
  createdBy?: string | null;
  updatedBy?: string | null;
}

export class PromptTemplateFactory {
  static CreatePromptTemplate(props: CreatePromptTemplateProps): PromptTemplateEntity {
    const id = generateId();
    const now = new Date();
    return new PromptTemplateEntity({
      id,
      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy ?? null,
      tenantId: props.tenantId ?? '50000000-0000-0000-0000-000000000000',
      name: props.name ?? null,
      description: props.description ?? null,
      content: props.content ?? null,
      category: props.category ?? null,
      variables: props.variables ?? null,
      currentVersionNumber: props.currentVersionNumber ?? 1,
      departmentId: props.departmentId ?? null,
      tags: props.tags ?? [],
    });
  }
}
