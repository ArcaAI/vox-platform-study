/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Models from './';

export class ContextItemVersion extends BaseTenantDataModel {
  public contextItemId: string;
  public versionNumber: number;
  public content: string | null;
  public contentDiff: string | null;
  public changeReason: string | null;
  public changeSummary: string | null;
  public changedBy: string | null;
  public changeSource: string | null;
  public fieldChanges: JsonValue | null;

  constructor(data: ContextItemVersion & BaseTenantDataModel) {
    super(data);
    this.contextItemId = data.contextItemId;
    this.versionNumber = data.versionNumber;
    this.content = data.content;
    this.contentDiff = data.contentDiff;
    this.changeReason = data.changeReason;
    this.changeSummary = data.changeSummary;
    this.changedBy = data.changedBy;
    this.changeSource = data.changeSource;
    this.fieldChanges = data.fieldChanges;
  }
}
