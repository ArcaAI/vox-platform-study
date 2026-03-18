/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel } from '../../../common';
import * as Models from './';

export class DnaWritingStyleVersion extends BaseTenantDataModel {
    public dnaReportId: string | null;
    public versionNumber: number | null;
    public reportData: any | null;
    public styleText: string | null;
    public changeReason: string | null;
    public changedBy: string | null;

    constructor(data: DnaWritingStyleVersion & BaseTenantDataModel) {
        super(data);
        this.dnaReportId = data.dnaReportId;
        this.versionNumber = data.versionNumber;
        this.reportData = data.reportData;
        this.styleText = data.styleText;
        this.changeReason = data.changeReason;
        this.changedBy = data.changedBy;
    }
}
