/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class AiUsageOutbox extends BaseTenantDataModel {
  public payload: JsonValue;
  public status: Enums.AiUsageOutboxStatus;
  public attempts: number;
  public availableAt: Date;
  public lastError: string | null;

  constructor(data: AiUsageOutbox & BaseTenantDataModel) {
    super(data);
    this.payload = data.payload;
    this.status = data.status;
    this.attempts = data.attempts;
    this.availableAt = data.availableAt;
    this.lastError = data.lastError;
  }
}
