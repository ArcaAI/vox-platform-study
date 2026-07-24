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
  status?: 'DRAFT' | 'PUBLISHED' | 'APPROVED' | null;
  variables?: Record<string, unknown> | null;
  currentVersionNumber?: number | null;
  approvedVersionNumber?: number | null;
  departmentId?: string | null;
  scope?: 'TENANT_DEFAULT' | 'DEPARTMENT_DEFAULT' | 'USER_PERSONAL' | null;
  ownerUserId?: string | null;
  lastTestScore?: number | null;
  lastTestOutput?: string | null;
  lastTestAt?: Date | null;
  tags?: string[] | null;
  tenantId: string;
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
      tenantId: props.tenantId,
      name: props.name ?? null,
      description: props.description ?? null,
      content: props.content ?? null,
      category: props.category ?? null,
      status: props.status ?? 'DRAFT',
      variables: props.variables ?? null,
      currentVersionNumber: props.currentVersionNumber ?? 1,
      approvedVersionNumber: props.approvedVersionNumber ?? null,
      departmentId: props.departmentId ?? null,
      scope: props.scope ?? 'TENANT_DEFAULT',
      ownerUserId: props.ownerUserId ?? null,
      lastTestScore: props.lastTestScore ?? null,
      lastTestOutput: props.lastTestOutput ?? null,
      lastTestAt: props.lastTestAt ?? null,
      tags: props.tags ?? [],
    });
  }
}
