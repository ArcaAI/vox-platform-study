/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class Consultation extends BaseTenantDataModel {
    public patientId: string;
    public appointmentDate: Date;
    public doctorId: string;
    public departmentId: string | null;
    public parentConsultationId: string | null;
    public metadata: JsonValue | null;
    public resourceStatus: Enums.ResourceStatusType;
    public resourceStatusUpdatedAt: Date | null;
    public resourceStatusUpdatedBy: string | null;

    constructor(data: Consultation & BaseTenantDataModel) {
        super(data);
        this.patientId = data.patientId;
        this.appointmentDate = data.appointmentDate;
        this.doctorId = data.doctorId;
        this.departmentId = data.departmentId;
        this.parentConsultationId = data.parentConsultationId;
        this.metadata = data.metadata;
        this.resourceStatus = data.resourceStatus;
        this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
        this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
    }
}
