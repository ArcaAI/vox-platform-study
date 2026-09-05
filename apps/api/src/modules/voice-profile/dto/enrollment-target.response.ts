import { ApiProperty } from '@nestjs/swagger';

/**
 * TASK-887 — where an enrollment would land.
 *
 * A voice profile is only ever matched by an agent bound to the model that embedded it, so a
 * client needs to know that model to tell the user which of their profiles are still live for
 * the agent they will actually transcribe with, and which need re-enrolling.
 */
export class VoiceProfileEnrollmentTargetResponse {
  @ApiProperty({ description: 'The resolved agent (the assigned one when the caller named none).' })
  agentSlug!: string;

  @ApiProperty({ description: 'AiModel slug of the agent’s speaker-embedding model — matches UserVoiceProfile.modelId.' })
  modelId!: string;

  @ApiProperty({ description: 'Whether the agent currently has diarization switched on.' })
  diarizationEnabled!: boolean;

  static from(target: { agentSlug: string; modelId: string; diarizationEnabled: boolean }): VoiceProfileEnrollmentTargetResponse {
    const r = new VoiceProfileEnrollmentTargetResponse();
    r.agentSlug = target.agentSlug;
    r.modelId = target.modelId;
    r.diarizationEnabled = target.diarizationEnabled;
    return r;
  }
}
