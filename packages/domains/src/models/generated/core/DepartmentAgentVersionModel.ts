/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel, VirtualDbProperty } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class DepartmentAgentVersion extends BaseTenantDataModel {
  public agentId: string;
  public versionNumber: number;
  public configSnapshot: JsonValue;
  public checksum: string;
  public changeReason: string | null;
  @VirtualDbProperty()
  public Agent: Models.DepartmentAgent | undefined;

  constructor(data: DepartmentAgentVersion & BaseTenantDataModel) {
    super(data);
    this.agentId = data.agentId;
    this.versionNumber = data.versionNumber;
    this.configSnapshot = data.configSnapshot;
    this.checksum = data.checksum;
    this.changeReason = data.changeReason;
    this.Agent = data.Agent;
  }
}
