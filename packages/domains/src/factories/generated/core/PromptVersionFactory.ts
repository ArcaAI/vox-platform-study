/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { PromptVersionEntity } from '../../../entities/generated/core/PromptVersionEntity';

export interface CreatePromptVersionProps extends BaseEntityFactoryCreateProps {
  promptTemplateId?: string | null;
  versionNumber?: number | null;
  content?: string | null;
  variables?: Record<string, unknown> | null;
  changeReason?: string | null;
  changedBy?: string | null;
  tenantId: string;
  createdAt?: Date;
  updatedAt?: Date;
  createdBy?: string | null;
  updatedBy?: string | null;
}

export class PromptVersionFactory {
  static CreatePromptVersion(props: CreatePromptVersionProps): PromptVersionEntity {
    const id = generateId();
    const now = new Date();
    return new PromptVersionEntity({
      id,
      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy ?? null,
      tenantId: props.tenantId,
      promptTemplateId: props.promptTemplateId ?? null,
      versionNumber: props.versionNumber ?? null,
      content: props.content ?? null,
      variables: props.variables ?? null,
      changeReason: props.changeReason ?? null,
      changedBy: props.changedBy ?? null,
    });
  }
}
