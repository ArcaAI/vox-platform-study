/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel, VirtualDbProperty } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class ChangelogEntry extends BaseTenantDataModel {
  public platformVersion: string;
  public title: string;
  public summary: string;
  public body: string;
  public severity: Enums.ChangelogSeverity;
  public audience: Enums.ChangelogAudience;
  public publishStatus: Enums.ChangelogPublishStatus;
  public publishedAt: Date | null;
  @VirtualDbProperty()
  public acknowledgements: Models.UserChangelogAcknowledgement[] | undefined;

  constructor(data: ChangelogEntry & BaseTenantDataModel) {
    super(data);
    this.platformVersion = data.platformVersion;
    this.title = data.title;
    this.summary = data.summary;
    this.body = data.body;
    this.severity = data.severity;
    this.audience = data.audience;
    this.publishStatus = data.publishStatus;
    this.publishedAt = data.publishedAt;
    this.acknowledgements = data.acknowledgements;
  }
}
