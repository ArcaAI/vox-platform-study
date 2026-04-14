/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { UserVoiceProfileEntity, IUserVoiceProfileEntity } from '../../../entities';

export interface CreateUserVoiceProfileProps extends BaseEntityFactoryCreateProps {
  userId: IUserVoiceProfileEntity['userId'];
  qualityScore: IUserVoiceProfileEntity['qualityScore'];
  isActive?: IUserVoiceProfileEntity['isActive'];
  label?: IUserVoiceProfileEntity['label'];
  modelId?: IUserVoiceProfileEntity['modelId'];

  createdAt?: IUserVoiceProfileEntity['createdAt'];
  updatedAt?: IUserVoiceProfileEntity['updatedAt'];
  createdBy?: IUserVoiceProfileEntity['createdBy'];
  updatedBy?: IUserVoiceProfileEntity['updatedBy'];
}

export class UserVoiceProfileFactory {
  static CreateUserVoiceProfile(props: CreateUserVoiceProfileProps): UserVoiceProfileEntity {
    const id = generateId();
    const now = new Date();

    return new UserVoiceProfileEntity({
      id,

      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: props.updatedBy || null,

      userId: props.userId,
      qualityScore: props.qualityScore,
      isActive: props.isActive ?? false,
      label: props.label ?? null,
      modelId: props.modelId ?? null,
    });
  }
}
