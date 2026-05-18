/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import Decimal from 'decimal.js';
import { BusinessException } from '@arcaai/exceptions';
import { BaseEntity, IBaseEntity } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface IUserProfileEntity extends Omit<IBaseEntity, 'tenantId'> {
  firstName?: string | null;
  lastName?: string | null;
  email?: string | null;
  phone?: string | null;
  avatarId?: string | null;
  userId: string;
  User: Entities.UserEntity | null;
}

export class UserProfileEntity extends BaseEntity {
  private _firstName?: IUserProfileEntity['firstName'];
  private _lastName?: IUserProfileEntity['lastName'];
  private _email?: IUserProfileEntity['email'];
  private _phone?: IUserProfileEntity['phone'];
  private _avatarId?: IUserProfileEntity['avatarId'];
  private _userId: IUserProfileEntity['userId'];
  private _User: IUserProfileEntity['User'];

  constructor(init: IUserProfileEntity) {
    super(init);
    this._firstName = init.firstName;
    this._lastName = init.lastName;
    this._email = init.email;
    this._phone = init.phone;
    this._avatarId = init.avatarId;
    this._userId = init.userId;
    this._User = init.User;
  }

  get firstName(): IUserProfileEntity['firstName'] {
    return this._firstName;
  }

  set firstName(value: IUserProfileEntity['firstName']) {
    this.setProperty('firstName', value);
  }

  get lastName(): IUserProfileEntity['lastName'] {
    return this._lastName;
  }

  set lastName(value: IUserProfileEntity['lastName']) {
    this.setProperty('lastName', value);
  }

  get email(): IUserProfileEntity['email'] {
    return this._email;
  }

  set email(value: IUserProfileEntity['email']) {
    this.setProperty('email', value);
  }

  get phone(): IUserProfileEntity['phone'] {
    return this._phone;
  }

  set phone(value: IUserProfileEntity['phone']) {
    this.setProperty('phone', value);
  }

  get avatarId(): IUserProfileEntity['avatarId'] {
    return this._avatarId;
  }

  set avatarId(value: IUserProfileEntity['avatarId']) {
    this.setProperty('avatarId', value);
  }

  get userId(): IUserProfileEntity['userId'] {
    return this._userId;
  }

  set userId(value: IUserProfileEntity['userId']) {
    this.setProperty('userId', value);
  }

  get User(): IUserProfileEntity['User'] {
    return this._User;
  }

  set User(value: IUserProfileEntity['User']) {
    this.setProperty('User', value);
  }

  public override validate(): void {
    if (!this._userId || this._userId.trim().length === 0) {
      throw new BusinessException('User profile userId is required.');
    }
    if (this._firstName && this._firstName.length > 255) {
      throw new BusinessException('User profile firstName must not exceed 255 characters.');
    }
    if (this._lastName && this._lastName.length > 255) {
      throw new BusinessException('User profile lastName must not exceed 255 characters.');
    }
    if (this._email && this._email.length > 255) {
      throw new BusinessException('User profile email must not exceed 255 characters.');
    }
    if (this._phone && this._phone.length > 255) {
      throw new BusinessException('User profile phone must not exceed 255 characters.');
    }
    if (this._avatarId && this._avatarId.length > 255) {
      throw new BusinessException('User profile avatarId must not exceed 255 characters.');
    }
  }
}
