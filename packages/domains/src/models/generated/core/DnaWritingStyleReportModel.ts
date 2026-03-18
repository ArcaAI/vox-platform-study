/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel } from '../../../common';
import * as Enums from '../../../enums';
import * as Models from './';

export class DnaWritingStyleReport extends BaseTenantDataModel {
    public doctorId: string | null;
    public departmentId: string | null;
    public reportData: any | null;
    public styleText: string | null;
    public isLatest: boolean;
    public currentVersionNumber: number | null;
    public resourceStatus: Enums.ResourceStatusType;
    public resourceStatusUpdatedAt: Date | null;
    public resourceStatusUpdatedBy: string | null;

    constructor(data: DnaWritingStyleReport & BaseTenantDataModel) {
        super(data);
        this.doctorId = data.doctorId;
        this.departmentId = data.departmentId;
        this.reportData = data.reportData;
        this.styleText = data.styleText;
        this.isLatest = data.isLatest;
        this.currentVersionNumber = data.currentVersionNumber;
        this.resourceStatus = data.resourceStatus;
        this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
        this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
    }
}
