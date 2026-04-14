/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseEntity, IBaseEntity } from '../../../common';
import * as Enums from '../../../enums';

export interface IUserVoiceProfileEntity extends IBaseEntity {
  userId: string;
  qualityScore: number;
  isActive: boolean;
  label?: string | null;
  modelId?: string | null;
}

export class UserVoiceProfileEntity extends BaseEntity {
  private _userId: IUserVoiceProfileEntity['userId'];
  private _qualityScore: IUserVoiceProfileEntity['qualityScore'];
  private _isActive: IUserVoiceProfileEntity['isActive'];
  private _label?: IUserVoiceProfileEntity['label'];
  private _modelId?: IUserVoiceProfileEntity['modelId'];

  constructor(init: IUserVoiceProfileEntity) {
    super(init);
    this._userId = init.userId;
    this._qualityScore = init.qualityScore;
    this._isActive = init.isActive;
    this._label = init.label;
    this._modelId = init.modelId;
  }

  get userId(): IUserVoiceProfileEntity['userId'] {
    return this._userId;
  }

  set userId(value: IUserVoiceProfileEntity['userId']) {
    this.setProperty('userId', value);
  }

  get qualityScore(): IUserVoiceProfileEntity['qualityScore'] {
    return this._qualityScore;
  }

  set qualityScore(value: IUserVoiceProfileEntity['qualityScore']) {
    this.setProperty('qualityScore', value);
  }

  get isActive(): IUserVoiceProfileEntity['isActive'] {
    return this._isActive;
  }

  set isActive(value: IUserVoiceProfileEntity['isActive']) {
    this.setProperty('isActive', value);
  }

  get label(): IUserVoiceProfileEntity['label'] {
    return this._label;
  }

  set label(value: IUserVoiceProfileEntity['label']) {
    this.setProperty('label', value);
  }

  get modelId(): IUserVoiceProfileEntity['modelId'] {
    return this._modelId;
  }

  set modelId(value: IUserVoiceProfileEntity['modelId']) {
    this.setProperty('modelId', value);
  }

  public override validate(): void {
    if (!this._userId) {
      throw new BusinessException('User ID is required');
    }
    if (this._qualityScore < 0 || this._qualityScore > 1) {
      throw new BusinessException('Quality score must be between 0 and 1');
    }
  }
}
