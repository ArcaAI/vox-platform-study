/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';
import type { DnaWritingStyleReportEntity } from './DnaWritingStyleReportEntity';

export interface IDnaWritingStyleVersionEntity extends IBaseTenantEntity {
    dnaReportId?: string | null;
    versionNumber?: number | null;
    reportData?: Record<string, unknown> | null;
    styleText?: string | null;
    changeReason?: string | null;
    changedBy?: string | null;
    DnaWritingStyleReport?: DnaWritingStyleReportEntity | null;
}

export class DnaWritingStyleVersionEntity extends BaseTenantEntity {
    private _dnaReportId?: IDnaWritingStyleVersionEntity['dnaReportId'];
    private _versionNumber?: IDnaWritingStyleVersionEntity['versionNumber'];
    private _reportData?: IDnaWritingStyleVersionEntity['reportData'];
    private _styleText?: IDnaWritingStyleVersionEntity['styleText'];
    private _changeReason?: IDnaWritingStyleVersionEntity['changeReason'];
    private _changedBy?: IDnaWritingStyleVersionEntity['changedBy'];
    private _DnaWritingStyleReport?: IDnaWritingStyleVersionEntity['DnaWritingStyleReport'];

    constructor(init: IDnaWritingStyleVersionEntity) {
        super(init);
        this._dnaReportId = init.dnaReportId;
        this._versionNumber = init.versionNumber;
        this._reportData = init.reportData;
        this._styleText = init.styleText;
        this._changeReason = init.changeReason;
        this._changedBy = init.changedBy;
        this._DnaWritingStyleReport = init.DnaWritingStyleReport;
    }

    get dnaReportId(): IDnaWritingStyleVersionEntity['dnaReportId'] {
        return this._dnaReportId;
    }

    set dnaReportId(value: IDnaWritingStyleVersionEntity['dnaReportId']) {
        this.setProperty('dnaReportId', value);
    }

    get versionNumber(): IDnaWritingStyleVersionEntity['versionNumber'] {
        return this._versionNumber ?? null;
    }

    set versionNumber(value: IDnaWritingStyleVersionEntity['versionNumber']) {
        this.setProperty('versionNumber', value);
    }

    get reportData(): IDnaWritingStyleVersionEntity['reportData'] {
        return this._reportData;
    }

    set reportData(value: IDnaWritingStyleVersionEntity['reportData']) {
        this.setProperty('reportData', value);
    }

    get styleText(): IDnaWritingStyleVersionEntity['styleText'] {
        return this._styleText;
    }

    set styleText(value: IDnaWritingStyleVersionEntity['styleText']) {
        this.setProperty('styleText', value);
    }

    get changeReason(): IDnaWritingStyleVersionEntity['changeReason'] {
        return this._changeReason;
    }

    set changeReason(value: IDnaWritingStyleVersionEntity['changeReason']) {
        this.setProperty('changeReason', value);
    }

    get changedBy(): IDnaWritingStyleVersionEntity['changedBy'] {
        return this._changedBy;
    }

    set changedBy(value: IDnaWritingStyleVersionEntity['changedBy']) {
        this.setProperty('changedBy', value);
    }

    get DnaWritingStyleReport(): IDnaWritingStyleVersionEntity['DnaWritingStyleReport'] {
        return this._DnaWritingStyleReport;
    }

    set DnaWritingStyleReport(value: IDnaWritingStyleVersionEntity['DnaWritingStyleReport']) {
        this.setProperty('DnaWritingStyleReport', value);
    }

    public override validate(): void {}
}
