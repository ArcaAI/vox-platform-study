import { IsBoolean, IsOptional, IsString, MaxLength } from 'class-validator';
import { ApiPropertyOptional } from '@nestjs/swagger';
import { StopRecordingRequest } from '@arcaai/applications';

/** Body of `POST consultations/:id/start`. */
export class StartConsultationRequest {
  @ApiPropertyOptional({
    description:
      'The STT streaming session the audio arrives on (from `POST audio/transcription-jobs/stream/session`). A session that is no longer live is 409 `STT_SESSION_NOT_ACTIVE`.',
  })
  @IsOptional()
  @IsString()
  sessionId?: string;
}

/**
 * Body of `POST consultations/:id/stop`. Extends the recording-stop body (`persistSnapshot`,
 * `acceptedProposals`) with `waitForFinal`.
 */
export class StopConsultationRequest extends StopRecordingRequest {
  @ApiPropertyOptional({
    description:
      'Hold the response (up to the tenant`s final-transcript timeout) until the final transcript is rebuilt. Default true. ' +
      'When the wait ends first, `finalTranscript.state` is `pending`: re-POST stop (an idempotent no-op on a STOPPED consultation) or wait for the `transcript_final` lifecycle event.',
    default: true,
  })
  @IsOptional()
  @IsBoolean()
  waitForFinal?: boolean;
}

/** Body of `POST consultations/:id/approve`. */
export class ApproveConsultationRequest {
  @ApiPropertyOptional({
    description:
      'The clinician who approves. REQUIRED for a machine credential (API key / service account) — a machine is never the attesting clinician; ' +
      'a human may name another clinician only while holding SUPER_ADMIN or TENANT_ADMIN, and omits it to act as themselves.',
  })
  @IsOptional()
  @IsString()
  clinicianUserId?: string;

  @ApiPropertyOptional({ description: 'Approve despite an open safety flag on the note (recorded on the attestation).' })
  @IsOptional()
  @IsBoolean()
  overrideSafetyFlag?: boolean;
}

/** Body of `POST consultations/:id/reopen`. */
export class ReopenConsultationRequest {
  @ApiPropertyOptional({
    description:
      'The clinician this reopen is attributed to, under the attribution rule of `close`. Optional for every caller: a service account ' +
      'that omits it reopens for the clinician the consultation names (a machine is never the clinician); a human or API key acts for themselves.',
  })
  @IsOptional()
  @IsString()
  clinicianUserId?: string;

  @ApiPropertyOptional({ description: 'Why the consultation is reopened (audited). At most 256 characters.', maxLength: 256 })
  @IsOptional()
  @IsString()
  @MaxLength(256)
  reason?: string;
}
