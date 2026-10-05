import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';

const STATUSES = ['OPEN', 'RECORDING', 'PAUSED', 'STOPPED', 'APPROVED', 'CLOSED_COMPLETE', 'CLOSED_INCOMPLETE'];
const PROCESSING = ['IDLE', 'FINALIZING_TRANSCRIPT', 'SUMMARIZING', 'PROCESSING_ATTACHMENT', 'AWAITING_REVIEW', 'FAILED'];

/** The real lifecycle pair, whatever vocabulary `status` is projected to. */
export class LifecyclePairResponse {
  @ApiProperty({ enum: STATUSES })
  status: string;

  @ApiProperty({ enum: PROCESSING })
  processing: string;
}

/** Answer of `POST consultations/:id/start` and `…/pause`. */
export class CaptureStateResponse {
  @ApiProperty()
  consultationId: string;

  @ApiProperty({
    enum: STATUSES,
    description:
      'Lifecycle status. Without the `X-Hope-Lifecycle: 2` request header it is answered in the previous vocabulary (PAUSED reads RECORDING, STOPPED reads DRAINING / DRAFT_PENDING_SENSORS / PENDING_REVIEW, APPROVED reads SIGNED); `lifecycle.status` always carries the current value.',
  })
  status: string;

  @ApiProperty({ enum: PROCESSING, description: 'What the platform is doing for the consultation, independent of `status`. A written note is IDLE with `processingReason` NOTE_READY; AWAITING_REVIEW means a human must look at it (coverage gaps or an escalation).' })
  processing: string;

  @ApiProperty({ description: 'The encounter (visit) the capture belongs to.' })
  encounterSeq: number;

  @ApiPropertyOptional({ description: 'The STT streaming session bound by this start, echoed.' })
  sessionId?: string;

  @ApiProperty()
  recording: boolean;

  @ApiProperty()
  paused: boolean;

  @ApiProperty({ description: 'The consultation `_version` after the command; the If-Match value for approve / close / reopen.' })
  version: number;

  @ApiProperty({ description: 'ISO-8601.' })
  updatedAt: string;

  @ApiPropertyOptional({ type: LifecyclePairResponse, description: 'Present when `status` was projected for an older client.' })
  lifecycle?: LifecyclePairResponse;
}

export class FinalTranscriptStateResponse {
  @ApiProperty({ enum: ['complete', 'pending'], description: '`pending`: the transcript is still being finalized; re-POST stop to poll.' })
  state: 'complete' | 'pending';

  @ApiProperty({ type: String, nullable: true, description: 'The FULL_TRANSCRIPT item, once rebuilt.' })
  contextItemId: string | null;

  @ApiProperty({ type: Number, nullable: true })
  versionNumber: number | null;

  @ApiProperty()
  segmentCount: number;

  @ApiProperty()
  lastSegmentSeq: number;
}

/** Answer of `POST consultations/:id/stop`. */
export class StopResultResponse extends CaptureStateResponse {
  @ApiProperty({ type: FinalTranscriptStateResponse })
  finalTranscript: FinalTranscriptStateResponse;
}

export class ConsultationRecordingPartResponse {
  @ApiProperty()
  audioRecordingId: string;

  @ApiProperty()
  encounterSeq: number;

  @ApiProperty({ description: 'Where this part starts on the consultation recording timeline (ms).' })
  startMs: number;

  @ApiProperty()
  durationMs: number;

  @ApiProperty({ type: String, nullable: true, description: 'Presigned download URL, or null when the stored object could not be signed.' })
  url: string | null;

  @ApiProperty({ type: String, nullable: true, description: 'When `url` stops working (ISO-8601).' })
  expiresAt: string | null;
}

/** Answer of `GET consultations/:id/recording`: the one recording of the consultation, part by part. */
export class ConsultationRecordingResponse {
  @ApiProperty({ description: 'The AUDIO_RECORDING item.' })
  contextItemId: string;

  @ApiProperty({ description: 'Its current version (each stop appends one).' })
  versionNumber: number;

  @ApiProperty({ type: String, nullable: true, example: 'opus' })
  codec: string | null;

  @ApiProperty()
  totalMs: number;

  @ApiProperty({ type: [ConsultationRecordingPartResponse] })
  parts: ConsultationRecordingPartResponse[];
}
