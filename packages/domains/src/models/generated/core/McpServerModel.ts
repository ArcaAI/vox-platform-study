/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class McpServer extends BaseTenantDataModel {
  public name: string;
  public description: string | null;
  public baseUrl: string;
  public transport: string;
  public authRef: string | null;
  public toolAllowlist: JsonValue | null;
  public phiBoundary: string;
  public enabled: boolean;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;

  constructor(data: McpServer & BaseTenantDataModel) {
    super(data);
    this.name = data.name;
    this.description = data.description;
    this.baseUrl = data.baseUrl;
    this.transport = data.transport;
    this.authRef = data.authRef;
    this.toolAllowlist = data.toolAllowlist;
    this.phiBoundary = data.phiBoundary;
    this.enabled = data.enabled;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
  }
}
