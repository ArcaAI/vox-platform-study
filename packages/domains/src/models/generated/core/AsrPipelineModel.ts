/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class AsrPipeline extends BaseTenantDataModel {
  public name: string;
  public slug: string;
  public description: string | null;
  public configYaml: string;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;
  public tags: string[];

  // Relations
  public TranscriptionJobs?: Models.TranscriptionJob[];

  constructor(data: AsrPipeline & BaseTenantDataModel) {
    super(data);
    this.name = data.name;
    this.slug = data.slug;
    this.description = data.description;
    this.configYaml = data.configYaml;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
    this.tags = data.tags ?? [];
    this.TranscriptionJobs = data.TranscriptionJobs;
  }
}
