/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel, VirtualDbProperty } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class PromptVersion extends BaseTenantDataModel {
  public promptTemplateId: string;
  public versionNumber: number;
  public content: string;
  public variables: JsonValue | null;
  public changeReason: string | null;
  public changedBy: string | null;
  @VirtualDbProperty()
  public PromptTemplate: Models.PromptTemplate | undefined;

  constructor(data: PromptVersion & BaseTenantDataModel) {
    super(data);
    this.promptTemplateId = data.promptTemplateId;
    this.versionNumber = data.versionNumber;
    this.content = data.content;
    this.variables = data.variables;
    this.changeReason = data.changeReason;
    this.changedBy = data.changedBy;
    this.PromptTemplate = data.PromptTemplate;
  }
}
