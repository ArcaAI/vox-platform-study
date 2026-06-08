import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsBoolean, IsOptional, IsString } from 'class-validator';

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
