/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { WebhookRunHistoryEntity, IWebhookRunHistoryEntity } from '../../../entities';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface CreateWebhookRunHistoryProps extends BaseEntityFactoryCreateProps {
  status: IWebhookRunHistoryEntity['status'];
  response?: IWebhookRunHistoryEntity['response'];
  responeStatusCode?: IWebhookRunHistoryEntity['responeStatusCode'];
  webhookId: IWebhookRunHistoryEntity['webhookId'];
  Webhook?: IWebhookRunHistoryEntity['Webhook'];

  createdAt?: IWebhookRunHistoryEntity['createdAt'];
  updatedAt?: IWebhookRunHistoryEntity['updatedAt'];
  createdBy?: IWebhookRunHistoryEntity['createdBy'];
  updatedBy?: IWebhookRunHistoryEntity['updatedBy'];
}

export class WebhookRunHistoryFactory {
  static CreateWebhookRunHistory(props: CreateWebhookRunHistoryProps): WebhookRunHistoryEntity {
    const id = generateId();
    const now = new Date();

    return new WebhookRunHistoryEntity({
      id,

      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy || null,

      status: props.status,
      response: props.response ?? null,
      responeStatusCode: props.responeStatusCode ?? 0,
      webhookId: props.webhookId,
      Webhook: props.Webhook ?? null,
    });
  }
}
