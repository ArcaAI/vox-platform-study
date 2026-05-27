/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import Decimal from 'decimal.js';
import { BusinessException } from '@arcaai/exceptions';
import { BaseTaggedEntity, IBaseTaggedEntity } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface IUserMediaEntity extends Omit<IBaseTaggedEntity, 'tenantId'> {
  sharedAt?: Date | null;
  userId: string;
  User: Entities.UserEntity | null;
  mediaId: string;
  Media: Entities.MediaEntity | null;
}

export class UserMediaEntity extends BaseTaggedEntity {
  private _sharedAt?: IUserMediaEntity['sharedAt'];
  private _userId: IUserMediaEntity['userId'];
  private _User: IUserMediaEntity['User'];
  private _mediaId: IUserMediaEntity['mediaId'];
  private _Media: IUserMediaEntity['Media'];

  constructor(init: IUserMediaEntity) {
    // UserMedia is the global User<->Media join (no `tenantId` column on
    // core.UserMedia; IUserMediaEntity uses `Omit<IBaseTaggedEntity,
    // 'tenantId'>`). Same rationale as UserEntity: pass a placeholder for
    // the BaseTenantEntity contract (TASK-305 A.7); never persisted; the
    // existing validate() override does not call super.validate() so the
    // base empty-tenantId guard never fires here.
    super({ ...init, tenantId: '' });
    this._sharedAt = init.sharedAt;
    this._userId = init.userId;
    this._User = init.User;
    this._mediaId = init.mediaId;
    this._Media = init.Media;
  }

  get sharedAt(): IUserMediaEntity['sharedAt'] {
    return this._sharedAt;
  }

  set sharedAt(value: IUserMediaEntity['sharedAt']) {
    this.setProperty('sharedAt', value);
  }

  get userId(): IUserMediaEntity['userId'] {
    return this._userId;
  }

  set userId(value: IUserMediaEntity['userId']) {
    this.setProperty('userId', value);
  }

  get User(): IUserMediaEntity['User'] {
    return this._User;
  }

  set User(value: IUserMediaEntity['User']) {
    this.setProperty('User', value);
  }

  get mediaId(): IUserMediaEntity['mediaId'] {
    return this._mediaId;
  }

  set mediaId(value: IUserMediaEntity['mediaId']) {
    this.setProperty('mediaId', value);
  }

  get Media(): IUserMediaEntity['Media'] {
    return this._Media;
  }

  set Media(value: IUserMediaEntity['Media']) {
    this.setProperty('Media', value);
  }

  public override validate(): void {
    if (!this._userId || this._userId.trim().length === 0) {
      throw new BusinessException('User media userId is required.');
    }
    if (!this._mediaId || this._mediaId.trim().length === 0) {
      throw new BusinessException('User media mediaId is required.');
    }
  }
}
