/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel } from '../../../common';
import * as Models from './';

export class PromptVersion extends BaseTenantDataModel {
    public promptTemplateId: string | null;
    public versionNumber: number | null;
    public content: string | null;
    public variables: any | null;
    public changeReason: string | null;
    public changedBy: string | null;

    constructor(data: PromptVersion & BaseTenantDataModel) {
        super(data);
        this.promptTemplateId = data.promptTemplateId;
        this.versionNumber = data.versionNumber;
        this.content = data.content;
        this.variables = data.variables;
        this.changeReason = data.changeReason;
        this.changedBy = data.changedBy;
    }
}
