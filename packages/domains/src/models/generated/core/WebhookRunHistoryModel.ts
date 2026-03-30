/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseDataModel, VirtualDbProperty } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class WebhookRunHistory extends BaseDataModel {
  public status: Enums.WebhookRunStatus;
  public response: JsonValue | null;
  public responeStatusCode: number | null;
  public resourceStatus: Enums.ResourceStatusType;
  public resourceStatusUpdatedAt: Date | null;
  public resourceStatusUpdatedBy: string | null;
  public webhookId: string;
  @VirtualDbProperty()
  public Webhook: Models.Webhook | undefined;

  constructor(data: WebhookRunHistory & BaseDataModel) {
    super(data);
    this.status = data.status;
    this.response = data.response;
    this.responeStatusCode = data.responeStatusCode;
    this.resourceStatus = data.resourceStatus;
    this.resourceStatusUpdatedAt = data.resourceStatusUpdatedAt;
    this.resourceStatusUpdatedBy = data.resourceStatusUpdatedBy;
    this.webhookId = data.webhookId;
    this.Webhook = data.Webhook;
  }
}
