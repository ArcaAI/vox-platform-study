import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { Type } from 'class-transformer';
import { ArrayMaxSize, IsArray, IsBoolean, IsOptional, IsString, ValidateNested } from 'class-validator';
import { AcceptedCorrectionProposal } from '../../endpoint/dto/endpoint.request';

/**
 * Body for `POST /consultations/:id/recording/start`.
 *
 * The frontend first creates an STT streaming session
 * (`POST /api/v1/audio/transcription-jobs/stream/session` with the
 * consultationId), then passes the returned `sessionId` here so the
 * {@link LiveDocumentationService} can subscribe to `stt:result:{sessionId}`.
 * When omitted, the service falls back to a debounced re-read of accumulated
 * TRANSCRIPT content.
 */
export class StartRecordingRequest {
  @ApiPropertyOptional({ description: 'STT streaming session id (from POST /api/v1/audio/transcription-jobs/stream/session)' })
  @IsOptional()
  @IsString()
  sessionId?: string;
}

/**
 * Body for `POST /consultations/:id/recording/stop`.
 */
export class StopRecordingRequest {
  @ApiPropertyOptional({
    description: 'When true, persist the last running-summary snapshot as a PRE_SUMMARY context item before tearing the session down.',
    default: false,
  })
  @IsOptional()
  @IsBoolean()
  persistSnapshot?: boolean;

  /**
   * TASK-814 §2b — advisory transcript corrections the CLINICIAN accepted during the session
   * (`live-assist` stream, TASK-796). Forwarded to `LoopContextSignalService.signalConsultationEnding`
   * so the endpoint stage's `feedback.capture` node (TASK-812 DD-8) has something to promote
   * over the raw transcript. Reuses `AcceptedCorrectionProposal` — the exact shape
   * `CaptureFeedbackRequest` re-verifies server-side — rather than a second, drifting copy.
   */
  @ApiPropertyOptional({ description: 'Advisory corrections the clinician accepted, to promote over the raw transcript at endpoint time.', type: [AcceptedCorrectionProposal] })
  @IsOptional()
  @IsArray()
  @ArrayMaxSize(200)
  @ValidateNested({ each: true })
  @Type(() => AcceptedCorrectionProposal)
  acceptedProposals?: AcceptedCorrectionProposal[];
}

/**
 * Response for the recording lifecycle endpoints.
 */
export class RecordingStateResponse {
  @ApiProperty({ description: 'Consultation id' })
  consultationId: string;

  @ApiProperty({ description: 'Consultation lifecycle status after the transition (RECORDING on start; reverted on stop)' })
  status: string;

  @ApiProperty({ description: 'Whether a live-documentation session is now active' })
  recording: boolean;

  @ApiPropertyOptional({ description: 'STT streaming session id bound to this recording (echoed from the request)' })
  sessionId?: string;

  @ApiProperty({ description: 'SSE URL for the running live summary stream' })
  sseUrl: string;

  @ApiProperty({ description: 'ISO-8601 timestamp of the transition' })
  updatedAt: string;
}
