/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class DnaUsageRecord extends BaseTenantDataModel {
  public doctorId: string;
  public dnaReportId: string;
  public dnaVersionNumber: number | null;
  public consultationId: string | null;
  public departmentId: string | null;

  constructor(data: DnaUsageRecord & BaseTenantDataModel) {
    super(data);
    this.doctorId = data.doctorId;
    this.dnaReportId = data.dnaReportId;
    this.dnaVersionNumber = data.dnaVersionNumber;
    this.consultationId = data.consultationId;
    this.departmentId = data.departmentId;
  }
}
