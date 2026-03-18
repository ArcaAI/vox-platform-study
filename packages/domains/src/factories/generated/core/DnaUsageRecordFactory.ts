/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { DnaUsageRecordEntity } from '../../../entities/generated/core/DnaUsageRecordEntity';

export interface CreateDnaUsageRecordProps extends BaseEntityFactoryCreateProps {
    doctorId?: string | null;
    dnaReportId?: string | null;
    dnaVersionNumber?: number | null;
    consultationId?: string | null;
    departmentId?: string | null;
    tenantId?: string;
    createdAt?: Date;
    updatedAt?: Date;
    createdBy?: string | null;
    updatedBy?: string | null;
}

export class DnaUsageRecordFactory {
    static CreateDnaUsageRecord(props: CreateDnaUsageRecordProps): DnaUsageRecordEntity {
        const id = generateId();
        const now = new Date();
        return new DnaUsageRecordEntity({
            id,
            createdAt: props.createdAt || now,
            updatedAt: props.updatedAt || now,
            createdBy: props.createdBy ?? null,
            updatedBy: props.updatedBy ?? null,
            tenantId: props.tenantId ?? '50000000-0000-0000-0000-000000000000',
            doctorId: props.doctorId ?? null,
            dnaReportId: props.dnaReportId ?? null,
            dnaVersionNumber: props.dnaVersionNumber ?? null,
            consultationId: props.consultationId ?? null,
            departmentId: props.departmentId ?? null,
        });
    }
}
