/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { WebhookEntity, IWebhookEntity } from '../../../entities';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface CreateWebhookProps extends BaseEntityFactoryCreateProps {
  name: IWebhookEntity['name'];
  url: IWebhookEntity['url'];
  hashedSecret?: IWebhookEntity['hashedSecret'];
  resourceTypeName: IWebhookEntity['resourceTypeName'];
  resourceId?: IWebhookEntity['resourceId'];
  subscriptionMetadata?: IWebhookEntity['subscriptionMetadata'];
  WebhookRunHistorys?: IWebhookEntity['WebhookRunHistorys'];
  tenantId: IWebhookEntity['tenantId'];
  Tenant?: IWebhookEntity['Tenant'];
  tags?: IWebhookEntity['tags'];
  Tags?: IWebhookEntity['Tags'];

  createdAt?: IWebhookEntity['createdAt'];
  updatedAt?: IWebhookEntity['updatedAt'];
  createdBy?: IWebhookEntity['createdBy'];
  updatedBy?: IWebhookEntity['updatedBy'];
}

export class WebhookFactory {
  static CreateWebhook(props: CreateWebhookProps): WebhookEntity {
    const id = generateId();
    const now = new Date();

    return new WebhookEntity({
      id,

      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy || null,

      name: props.name,
      url: props.url,
      hashedSecret: props.hashedSecret ?? '',
      resourceTypeName: props.resourceTypeName,
      resourceId: props.resourceId ?? '',
      subscriptionMetadata: props.subscriptionMetadata ?? null,
      WebhookRunHistorys: props.WebhookRunHistorys ?? [],
      tenantId: props.tenantId,
      Tenant: props.Tenant ?? null,
      tags: props.tags ?? [],
      Tags: props.Tags ?? [],
    });
  }
}
