/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import Decimal from 'decimal.js';
import { BusinessException } from '@arcaai/exceptions';
import { BaseEntity, IBaseEntity } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface IWebhookRunHistoryEntity extends Omit<IBaseEntity, 'tenantId'> {
  status: Enums.WebhookRunStatus;
  response?: JsonValue | null;
  responeStatusCode?: number | null;
  webhookId: string;
  Webhook: Entities.WebhookEntity | null;
}

export class WebhookRunHistoryEntity extends BaseEntity {
  private _status: IWebhookRunHistoryEntity['status'];
  private _response?: IWebhookRunHistoryEntity['response'];
  private _responeStatusCode?: IWebhookRunHistoryEntity['responeStatusCode'];
  private _webhookId: IWebhookRunHistoryEntity['webhookId'];
  private _Webhook: IWebhookRunHistoryEntity['Webhook'];

  constructor(init: IWebhookRunHistoryEntity) {
    super(init);
    this._status = init.status;
    this._response = init.response;
    this._responeStatusCode = init.responeStatusCode;
    this._webhookId = init.webhookId;
    this._Webhook = init.Webhook;
  }

  get status(): IWebhookRunHistoryEntity['status'] {
    return this._status;
  }

  set status(value: IWebhookRunHistoryEntity['status']) {
    this.setProperty('status', value);
  }

  get response(): IWebhookRunHistoryEntity['response'] {
    return this._response;
  }

  set response(value: IWebhookRunHistoryEntity['response']) {
    this.setProperty('response', value);
  }

  get responeStatusCode(): IWebhookRunHistoryEntity['responeStatusCode'] {
    return this._responeStatusCode;
  }

  set responeStatusCode(value: IWebhookRunHistoryEntity['responeStatusCode']) {
    this.setProperty('responeStatusCode', value);
  }

  get webhookId(): IWebhookRunHistoryEntity['webhookId'] {
    return this._webhookId;
  }

  set webhookId(value: IWebhookRunHistoryEntity['webhookId']) {
    this.setProperty('webhookId', value);
  }

  get Webhook(): IWebhookRunHistoryEntity['Webhook'] {
    return this._Webhook;
  }

  set Webhook(value: IWebhookRunHistoryEntity['Webhook']) {
    this.setProperty('Webhook', value);
  }

  public override validate(): void {
    if (this._status === undefined || this._status === null) {
      throw new BusinessException('WebhookRunHistory status is required.');
    }
    if (!Object.values(Enums.WebhookRunStatus).includes(this._status)) {
      throw new BusinessException(`WebhookRunHistory status is invalid: ${String(this._status)}.`);
    }
    if (!this._webhookId || this._webhookId.trim().length === 0) {
      throw new BusinessException('WebhookRunHistory webhookId is required.');
    }
    if (this._responeStatusCode !== undefined && this._responeStatusCode !== null) {
      if (
        typeof this._responeStatusCode !== 'number' ||
        !Number.isInteger(this._responeStatusCode) ||
        this._responeStatusCode < 100 ||
        this._responeStatusCode > 599
      ) {
        throw new BusinessException(
          'WebhookRunHistory responeStatusCode must be a valid HTTP status code (100-599).',
        );
      }
    }
  }
}
