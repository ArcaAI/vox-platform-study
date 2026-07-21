/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BaseEntityFactoryCreateProps } from '../../../common';
import { IUserVoiceProfileEntity, UserVoiceProfileEntity } from '../../../entities';
import { generateId } from '../../../utils';

export interface CreateUserVoiceProfileProps extends BaseEntityFactoryCreateProps {
  // Enrollment tenant; voice-profile reads are tenant-scoped.
  tenantId: IUserVoiceProfileEntity['tenantId'];
  userId: IUserVoiceProfileEntity['userId'];
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

      tenantId: props.tenantId,
      userId: props.userId,
      isActive: props.isActive ?? false,
      label: props.label ?? null,
      modelId: props.modelId ?? null,
    });
  }
}
