/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';

// TASK-498 — links a HOPE user to a subject at a specific tenant IdP. `userId`
// is a loose ref to User.id (no Prisma relation — matches the `createdBy`/
// `updatedBy` audit-field convention). OIDC `sub`; SAML `NameID` reuses
// `subject` (TASK-499). One HOPE user may federate with multiple providers;
// unique on `(providerId, subject)` at the schema level.
export interface IFederatedIdentityEntity extends IBaseTenantEntity {
  userId: string;
  providerId: string;
  subject: string;
  lastLoginAt?: Date | null;
}

export class FederatedIdentityEntity extends BaseTenantEntity {
  private _userId: IFederatedIdentityEntity['userId'];
  private _providerId: IFederatedIdentityEntity['providerId'];
  private _subject: IFederatedIdentityEntity['subject'];
  private _lastLoginAt?: IFederatedIdentityEntity['lastLoginAt'];

  constructor(init: IFederatedIdentityEntity) {
    super(init);
    this._userId = init.userId;
    this._providerId = init.providerId;
    this._subject = init.subject;
    this._lastLoginAt = init.lastLoginAt;
  }

  get userId(): IFederatedIdentityEntity['userId'] {
    return this._userId;
  }

  set userId(value: IFederatedIdentityEntity['userId']) {
    this.setProperty('userId', value);
  }

  get providerId(): IFederatedIdentityEntity['providerId'] {
    return this._providerId;
  }

  set providerId(value: IFederatedIdentityEntity['providerId']) {
    this.setProperty('providerId', value);
  }

  get subject(): IFederatedIdentityEntity['subject'] {
    return this._subject;
  }

  set subject(value: IFederatedIdentityEntity['subject']) {
    this.setProperty('subject', value);
  }

  get lastLoginAt(): IFederatedIdentityEntity['lastLoginAt'] {
    return this._lastLoginAt;
  }

  set lastLoginAt(value: IFederatedIdentityEntity['lastLoginAt']) {
    this.setProperty('lastLoginAt', value);
  }

  public override validate(): void {
    super.validate();
    if (!this._userId || !this._userId.trim()) {
      throw new BusinessException('FederatedIdentity userId is required');
    }
    if (!this._providerId || !this._providerId.trim()) {
      throw new BusinessException('FederatedIdentity providerId is required');
    }
    if (!this._subject || !this._subject.trim()) {
      throw new BusinessException('FederatedIdentity subject is required');
    }
  }
}
