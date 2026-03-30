/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel } from '../../../common';
import * as Models from './';

export class PromptUsageRecord extends BaseTenantDataModel {
  public promptTemplateId: string | null;
  public promptVersionNumber: number | null;
  public consultationId: string | null;
  public doctorId: string | null;
  public departmentId: string | null;

  constructor(data: PromptUsageRecord & BaseTenantDataModel) {
    super(data);
    this.promptTemplateId = data.promptTemplateId;
    this.promptVersionNumber = data.promptVersionNumber;
    this.consultationId = data.consultationId;
    this.doctorId = data.doctorId;
    this.departmentId = data.departmentId;
  }
}
