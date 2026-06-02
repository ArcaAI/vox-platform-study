/**
 * @arcaai/vox - Audio Recording Types (TASK-329 P2 — dual-capture X8)
 *
 * Mirrors the API DTOs (`AudioRecordingResponse` / `AddAudioRecordingRequest`)
 * for the public `/consultations/:id/recordings` routes. A recording carries an
 * optional RAW (unprocessed) and PROCESSED media id so the consultation
 * playground can persist both streams from a single capture.
 */

export interface AudioRecording {
  id: string;
  mediaId: string;
  /** Media id of the RAW (unprocessed) capture. */
  rawMediaId?: string;
  /** Media id of the PROCESSED (noise-filtered/VAD-gated) capture. */
  processedMediaId?: string;
  duration?: number;
  durationFormatted?: string;
  format?: string;
  sampleRate?: number;
  channels?: number;
  language?: string;
  bitrate?: number;
  sequenceNumber: number;
  recordedAt?: string;
  createdAt: string;
}

export interface AddAudioRecordingInput {
  mediaId: string;
  rawMediaId?: string;
  processedMediaId?: string;
  duration?: number;
  format?: string;
  sampleRate?: number;
  channels?: number;
  bitrate?: number;
  language?: string;
  recordedAt?: string;
}
