/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';

/**
 * A transactional-outbox work item.
 *
 * Written INSIDE the business transaction that produced the usage, so usage can
 * never be lost by a crash between "work done" and "usage recorded", and can
 * never be recorded for work that rolled back. A drainer converts PENDING rows
 * into `AiUsageEvent` appends; exactly-once-effective delivery comes from the
 * ledger's unique `idempotencyKey`, so the drainer only needs at-least-once
 * semantics.
 *
 * Append-only work item, not history: no soft delete (drained rows are pruned),
 * no sys-events.
 */
export interface IAiUsageOutboxEntity extends IBaseTenantEntity {
  /** One or more `UsageEventInput` records (the WS-B contract). PHI-free. */
  payload: JsonValue;
  status?: Enums.AiUsageOutboxStatus;
  attempts?: number;
  /** Retry backoff — the drainer claims rows with `availableAt <= now()`. */
  availableAt?: Date;
  /** Bounded diagnostic (error class), never a payload dump. */
  lastError?: string | null;
}

export class AiUsageOutboxEntity extends BaseTenantEntity {
  private _payload: IAiUsageOutboxEntity['payload'];
  private _status?: IAiUsageOutboxEntity['status'];
  private _attempts?: IAiUsageOutboxEntity['attempts'];
  private _availableAt?: IAiUsageOutboxEntity['availableAt'];
  private _lastError?: IAiUsageOutboxEntity['lastError'];

  constructor(init: IAiUsageOutboxEntity) {
    super(init);
    this._payload = init.payload;
    this._status = init.status;
    this._attempts = init.attempts;
    this._availableAt = init.availableAt;
    this._lastError = init.lastError;
  }

  get payload(): IAiUsageOutboxEntity['payload'] {
    return this._payload;
  }

  set payload(value: IAiUsageOutboxEntity['payload']) {
    this.setProperty('payload', value);
  }

  get status(): IAiUsageOutboxEntity['status'] {
    return this._status;
  }

  set status(value: IAiUsageOutboxEntity['status']) {
    this.setProperty('status', value);
  }

  get attempts(): IAiUsageOutboxEntity['attempts'] {
    return this._attempts;
  }

  set attempts(value: IAiUsageOutboxEntity['attempts']) {
    this.setProperty('attempts', value);
  }

  get availableAt(): IAiUsageOutboxEntity['availableAt'] {
    return this._availableAt;
  }

  set availableAt(value: IAiUsageOutboxEntity['availableAt']) {
    this.setProperty('availableAt', value);
  }

  get lastError(): IAiUsageOutboxEntity['lastError'] {
    return this._lastError;
  }

  set lastError(value: IAiUsageOutboxEntity['lastError']) {
    this.setProperty('lastError', value);
  }

  public override validate(): void {
    super.validate();
    if (this._payload === undefined || this._payload === null) {
      throw new BusinessException('AiUsageOutbox payload is required.');
    }
    if (this._attempts !== undefined && this._attempts !== null && this._attempts < 0) {
      throw new BusinessException('AiUsageOutbox attempts cannot be negative.');
    }
  }
}
