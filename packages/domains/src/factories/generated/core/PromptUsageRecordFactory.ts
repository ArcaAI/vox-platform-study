/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { PromptUsageRecordEntity } from '../../../entities/generated/core/PromptUsageRecordEntity';

export interface CreatePromptUsageRecordProps extends BaseEntityFactoryCreateProps {
  promptTemplateId?: string | null;
  promptVersionNumber?: number | null;
  consultationId?: string | null;
  doctorId?: string | null;
  departmentId?: string | null;
  tenantId?: string;
  createdAt?: Date;
  updatedAt?: Date;
  createdBy?: string | null;
  updatedBy?: string | null;
}

export class PromptUsageRecordFactory {
  static CreatePromptUsageRecord(props: CreatePromptUsageRecordProps): PromptUsageRecordEntity {
    const id = generateId();
    const now = new Date();
    return new PromptUsageRecordEntity({
      id,
      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy ?? null,
      tenantId: props.tenantId ?? '50000000-0000-0000-0000-000000000000',
      promptTemplateId: props.promptTemplateId ?? null,
      promptVersionNumber: props.promptVersionNumber ?? null,
      consultationId: props.consultationId ?? null,
      doctorId: props.doctorId ?? null,
      departmentId: props.departmentId ?? null,
    });
  }
}
