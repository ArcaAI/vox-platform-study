import { EntityId, UserVoiceProfileEntity } from '@arcaai/domains';
import { IBaseService } from '../../../interfaces';
import { EnrollVoiceProfileRequest } from './dto';

export interface IVoiceProfileService extends IBaseService {
  enroll(request: EnrollVoiceProfileRequest): Promise<UserVoiceProfileEntity>;
  listByUserId(userId: string): Promise<UserVoiceProfileEntity[]>;
  activate(profileId: EntityId): Promise<void>;
  deactivate(profileId: EntityId): Promise<void>;
  deleteById(profileId: EntityId): Promise<UserVoiceProfileEntity>;
}
export const IVoiceProfileService = Symbol('IVoiceProfileService');
