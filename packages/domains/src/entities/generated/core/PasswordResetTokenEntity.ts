/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseEntity, IBaseEntity } from '../../../common';
import * as Enums from '../../../enums';

/**
 * TASK-400 — revocable, DB-backed, single-use password-reset token.
 *
 * Only the SHA-256 hash of the raw token is ever stored. Lifecycle is
 * column-driven and UPDATE-only (`usedAt` on completion, `revokedAt` on
 * supersession) — rows are never deleted so the trail stays auditable.
 * Not tenant-scoped: hangs off the platform-level User, like the User row.
 */
export interface IPasswordResetTokenEntity extends Omit<IBaseEntity, 'tenantId'> {
  userId: string;
  tokenHash: string;
  purpose: string;
  expiresAt: Date;
  usedAt?: Date | null;
  revokedAt?: Date | null;
  requestedByUserId?: string | null;
  requestedVia?: string | null;
  requestIp?: string | null;
}

export class PasswordResetTokenEntity extends BaseEntity {
  private _userId: IPasswordResetTokenEntity['userId'];
  private _tokenHash: IPasswordResetTokenEntity['tokenHash'];
  private _purpose: IPasswordResetTokenEntity['purpose'];
  private _expiresAt: IPasswordResetTokenEntity['expiresAt'];
  private _usedAt?: IPasswordResetTokenEntity['usedAt'];
  private _revokedAt?: IPasswordResetTokenEntity['revokedAt'];
  private _requestedByUserId?: IPasswordResetTokenEntity['requestedByUserId'];
  private _requestedVia?: IPasswordResetTokenEntity['requestedVia'];
  private _requestIp?: IPasswordResetTokenEntity['requestIp'];
  // TASK-497 §3.4 — `IBaseEntity.metaData` was declared but never wired on
  // `BaseEntity` (a pre-existing gap affecting every entity, out of scope
  // here); implemented locally so the `email_verification` purpose can stash
  // the pending tenant name until POST /auth/register/verify consumes it.
  private _metaData?: IPasswordResetTokenEntity['metaData'];

  constructor(init: IPasswordResetTokenEntity) {
    super(init);
    this._userId = init.userId;
    this._tokenHash = init.tokenHash;
    this._purpose = init.purpose;
    this._expiresAt = init.expiresAt;
    this._usedAt = init.usedAt;
    this._revokedAt = init.revokedAt;
    this._requestedByUserId = init.requestedByUserId;
    this._requestedVia = init.requestedVia;
    this._requestIp = init.requestIp;
    this._metaData = init.metaData;
  }

  get userId(): IPasswordResetTokenEntity['userId'] {
    return this._userId;
  }

  set userId(value: IPasswordResetTokenEntity['userId']) {
    this.setProperty('userId', value);
  }

  get tokenHash(): IPasswordResetTokenEntity['tokenHash'] {
    return this._tokenHash;
  }

  set tokenHash(value: IPasswordResetTokenEntity['tokenHash']) {
    this.setProperty('tokenHash', value);
  }

  get purpose(): IPasswordResetTokenEntity['purpose'] {
    return this._purpose;
  }

  set purpose(value: IPasswordResetTokenEntity['purpose']) {
    this.setProperty('purpose', value);
  }

  get expiresAt(): IPasswordResetTokenEntity['expiresAt'] {
    return this._expiresAt;
  }

  set expiresAt(value: IPasswordResetTokenEntity['expiresAt']) {
    this.setProperty('expiresAt', value);
  }

  get usedAt(): IPasswordResetTokenEntity['usedAt'] {
    return this._usedAt;
  }

  set usedAt(value: IPasswordResetTokenEntity['usedAt']) {
    this.setProperty('usedAt', value);
  }

  get revokedAt(): IPasswordResetTokenEntity['revokedAt'] {
    return this._revokedAt;
  }

  set revokedAt(value: IPasswordResetTokenEntity['revokedAt']) {
    this.setProperty('revokedAt', value);
  }

  get requestedByUserId(): IPasswordResetTokenEntity['requestedByUserId'] {
    return this._requestedByUserId;
  }

  set requestedByUserId(value: IPasswordResetTokenEntity['requestedByUserId']) {
    this.setProperty('requestedByUserId', value);
  }

  get requestedVia(): IPasswordResetTokenEntity['requestedVia'] {
    return this._requestedVia;
  }

  set requestedVia(value: IPasswordResetTokenEntity['requestedVia']) {
    this.setProperty('requestedVia', value);
  }

  get requestIp(): IPasswordResetTokenEntity['requestIp'] {
    return this._requestIp;
  }

  set requestIp(value: IPasswordResetTokenEntity['requestIp']) {
    this.setProperty('requestIp', value);
  }

  get metaData(): IPasswordResetTokenEntity['metaData'] {
    return this._metaData;
  }

  set metaData(value: IPasswordResetTokenEntity['metaData']) {
    this.setProperty('metaData', value);
  }

  /** Consumable right now: never used, never revoked, not yet expired. */
  public isActive(now: Date = new Date()): boolean {
    return !this._usedAt && !this._revokedAt && this._expiresAt.getTime() > now.getTime();
  }

  /** Single-use stamp — the completion path marks the token spent. */
  public markUsed(now: Date = new Date()): void {
    this.setProperty('usedAt', now);
  }

  /** Revocation stamp — a newer token (or a password change) supersedes this one. */
  public markRevoked(now: Date = new Date()): void {
    this.setProperty('revokedAt', now);
  }

  public override validate(): void {
    if (!this._userId || this._userId.trim().length === 0) {
      throw new BusinessException('PasswordResetToken userId is required.');
    }
    if (!this._tokenHash || this._tokenHash.trim().length === 0) {
      throw new BusinessException('PasswordResetToken tokenHash is required.');
    }
    if (!this._expiresAt) {
      throw new BusinessException('PasswordResetToken expiresAt is required.');
    }
  }
}
