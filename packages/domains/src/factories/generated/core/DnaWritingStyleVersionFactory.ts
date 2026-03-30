/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { DnaWritingStyleVersionEntity } from '../../../entities/generated/core/DnaWritingStyleVersionEntity';

export interface CreateDnaWritingStyleVersionProps extends BaseEntityFactoryCreateProps {
  dnaReportId?: string | null;
  versionNumber?: number | null;
  reportData?: Record<string, unknown> | null;
  styleText?: string | null;
  changeReason?: string | null;
  changedBy?: string | null;
  tenantId?: string;
  createdAt?: Date;
  updatedAt?: Date;
  createdBy?: string | null;
  updatedBy?: string | null;
}

export class DnaWritingStyleVersionFactory {
  static CreateDnaWritingStyleVersion(props: CreateDnaWritingStyleVersionProps): DnaWritingStyleVersionEntity {
    const id = generateId();
    const now = new Date();
    return new DnaWritingStyleVersionEntity({
      id,
      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy ?? null,
      tenantId: props.tenantId ?? '50000000-0000-0000-0000-000000000000',
      dnaReportId: props.dnaReportId ?? null,
      versionNumber: props.versionNumber ?? null,
      reportData: props.reportData ?? null,
      styleText: props.styleText ?? null,
      changeReason: props.changeReason ?? null,
      changedBy: props.changedBy ?? null,
    });
  }
}
