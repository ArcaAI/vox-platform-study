/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel, VirtualDbProperty } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class AsrPipelineVersion extends BaseTenantDataModel {
  public asrPipelineId: string;
  public versionNumber: number;
  public configYaml: string;
  public name: string | null;
  public description: string | null;
  public changeReason: string | null;
  public changedBy: string | null;
  @VirtualDbProperty()
  public AsrPipeline: Models.AsrPipeline | undefined;

  constructor(data: AsrPipelineVersion & BaseTenantDataModel) {
    super(data);
    this.asrPipelineId = data.asrPipelineId;
    this.versionNumber = data.versionNumber;
    this.configYaml = data.configYaml;
    this.name = data.name;
    this.description = data.description;
    this.changeReason = data.changeReason;
    this.changedBy = data.changedBy;
    this.AsrPipeline = data.AsrPipeline;
  }
}
