/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel, VirtualDbProperty } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class GoldenSet extends BaseTenantDataModel {
  public name: string;
  public description: string | null;
  public pinnedVersion: string | null;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;
  @VirtualDbProperty()
  public GoldenCases: Models.GoldenCase[] | undefined;
  @VirtualDbProperty()
  public EvalRuns: Models.EvalRun[] | undefined;

  constructor(data: GoldenSet & BaseTenantDataModel) {
    super(data);
    this.name = data.name;
    this.description = data.description;
    this.pinnedVersion = data.pinnedVersion;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
    this.GoldenCases = data.GoldenCases;
    this.EvalRuns = data.EvalRuns;
  }
}
