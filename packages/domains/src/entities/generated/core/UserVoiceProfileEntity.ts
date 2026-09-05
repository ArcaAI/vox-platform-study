/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';

// Voice profiles are biometric PHI stamped with their enrollment
// tenant (`UserVoiceProfile.tenantId`), so the entity is tenant-scoped.
export interface IUserVoiceProfileEntity extends IBaseTenantEntity {
  userId: string;
  isActive: boolean;
  label?: string | null;
  // TASK-887 — REQUIRED: the `AiModel` SLUG of the model that produced `embedding`. A profile
  // is only ever compared against profiles from the SAME model (diarization is a declared
  // ASR-agent option and the agent names the space), so a profile with no model is a vector
  // nothing may safely match against.
  modelId: string;
}

export class UserVoiceProfileEntity extends BaseTenantEntity {
  private _userId: IUserVoiceProfileEntity['userId'];
  private _isActive: IUserVoiceProfileEntity['isActive'];
  private _label?: IUserVoiceProfileEntity['label'];
  private _modelId: IUserVoiceProfileEntity['modelId'];

  constructor(init: IUserVoiceProfileEntity) {
    super(init);
    this._userId = init.userId;
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
    if (!this._modelId) {
      throw new BusinessException('Embedding model slug is required');
    }
  }
}
