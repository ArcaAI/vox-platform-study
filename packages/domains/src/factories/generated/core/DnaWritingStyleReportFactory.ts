/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { DnaWritingStyleReportEntity } from '../../../entities/generated/core/DnaWritingStyleReportEntity';

export interface CreateDnaWritingStyleReportProps extends BaseEntityFactoryCreateProps {
  doctorId?: string | null;
  departmentId?: string | null;
  reportData?: Record<string, unknown> | null;
  styleText?: string | null;
  redactionRules?: Record<string, unknown> | null;
  isLatest?: boolean | null;
  currentVersionNumber?: number | null;
  tenantId: string;
  createdAt?: Date;
  updatedAt?: Date;
  createdBy?: string | null;
  updatedBy?: string | null;
}

export class DnaWritingStyleReportFactory {
  static CreateDnaWritingStyleReport(props: CreateDnaWritingStyleReportProps): DnaWritingStyleReportEntity {
    const id = generateId();
    const now = new Date();
    return new DnaWritingStyleReportEntity({
      id,
      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy ?? null,
      tenantId: props.tenantId,
      doctorId: props.doctorId ?? null,
      departmentId: props.departmentId ?? null,
      reportData: props.reportData ?? null,
      styleText: props.styleText ?? null,
      redactionRules: props.redactionRules ?? null,
      isLatest: props.isLatest ?? true,
      currentVersionNumber: props.currentVersionNumber ?? 1,
    });
  }
}
