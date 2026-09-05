import { EntityId, UserVoiceProfileEntity } from '@arcaai/domains';
import { IBaseService } from '../../../interfaces';
import { EnrollVoiceProfileRequest, VoiceProfileEnrollmentTarget } from './dto';

/**
 * One enrolled profile as the ASR runtime consumes it (TASK-887) — the wire shape the gateway
 * pushes to `apps/stt` on the session-create body and the batch Dramatiq message.
 *
 * snake_case because it IS the Python wire, mapped once here rather than in every caller.
 */
export interface RuntimeVoiceProfile {
  profile_id: string;
  label: string | null;
  model_id: string;
  embedding: number[];
}

export interface IVoiceProfileService extends IBaseService {
  enroll(request: EnrollVoiceProfileRequest): Promise<UserVoiceProfileEntity>;
  listByUserId(userId: string): Promise<UserVoiceProfileEntity[]>;
  activate(profileId: EntityId): Promise<void>;
  deactivate(profileId: EntityId): Promise<void>;
  deleteById(profileId: EntityId): Promise<UserVoiceProfileEntity>;
  /** The embedding model a new enrollment would use, for `agentSlug` or the assigned agent. */
  enrollmentTarget(agentSlug?: string): Promise<VoiceProfileEnrollmentTarget>;
  /**
   * The user's ACTIVE profiles in `modelId`'s space, ready to push to `apps/stt`.
   *
   * Never throws: a session must open even when profile resolution fails — the cost is
   * generic `Speaker N` labels, and refusing to transcribe over it would be far worse.
   */
  listForRuntime(userId: string, tenantId: string, modelId: string): Promise<RuntimeVoiceProfile[]>;
}
export const IVoiceProfileService = Symbol('IVoiceProfileService');
