/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';

// Per-user, per-entry acknowledgement of the one-time "What's New" popup —
// server-side and per-user so support can answer "was this
// admin actually shown the breaking-change notice". Immutable once written.
// Scoped to the ACKNOWLEDGING USER'S OWN tenant — the one exception among the
// four Service Version & Release Registry models; everything else is
// platform-wide SYSTEM-tenant data.
export interface IUserChangelogAcknowledgementEntity extends IBaseTenantEntity {
  userId: string;
  changelogEntryId: string;
  acknowledgedAt: Date;
  autoAcknowledged: boolean;
}

export class UserChangelogAcknowledgementEntity extends BaseTenantEntity {
  private _userId: IUserChangelogAcknowledgementEntity['userId'];
  private _changelogEntryId: IUserChangelogAcknowledgementEntity['changelogEntryId'];
  private _acknowledgedAt: IUserChangelogAcknowledgementEntity['acknowledgedAt'];
  private _autoAcknowledged: IUserChangelogAcknowledgementEntity['autoAcknowledged'];

  constructor(init: IUserChangelogAcknowledgementEntity) {
    super(init);
    this._userId = init.userId;
    this._changelogEntryId = init.changelogEntryId;
    this._acknowledgedAt = init.acknowledgedAt;
    this._autoAcknowledged = init.autoAcknowledged;
  }

  get userId(): IUserChangelogAcknowledgementEntity['userId'] {
    return this._userId;
  }

  set userId(value: IUserChangelogAcknowledgementEntity['userId']) {
    this.setProperty('userId', value);
  }

  get changelogEntryId(): IUserChangelogAcknowledgementEntity['changelogEntryId'] {
    return this._changelogEntryId;
  }

  set changelogEntryId(value: IUserChangelogAcknowledgementEntity['changelogEntryId']) {
    this.setProperty('changelogEntryId', value);
  }

  get acknowledgedAt(): IUserChangelogAcknowledgementEntity['acknowledgedAt'] {
    return this._acknowledgedAt;
  }

  set acknowledgedAt(value: IUserChangelogAcknowledgementEntity['acknowledgedAt']) {
    this.setProperty('acknowledgedAt', value);
  }

  get autoAcknowledged(): IUserChangelogAcknowledgementEntity['autoAcknowledged'] {
    return this._autoAcknowledged;
  }

  set autoAcknowledged(value: IUserChangelogAcknowledgementEntity['autoAcknowledged']) {
    this.setProperty('autoAcknowledged', value);
  }

  public override validate(): void {
    super.validate();
    if (!this._userId || this._userId.trim().length === 0) {
      throw new BusinessException('User id is required');
    }
    if (!this._changelogEntryId || this._changelogEntryId.trim().length === 0) {
      throw new BusinessException('Changelog entry id is required');
    }
  }
}
