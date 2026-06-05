import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { IsString, IsNotEmpty, IsOptional, IsObject, IsNumber, IsUUID, IsIn, Min, Max } from 'class-validator';
import { JsonValue } from '@arcaai/domains';

/**
 * Request from STT-v2 service to create a transcript context item
 */
export class CreateTranscriptRequest {
  @ApiProperty({
    description: 'Transcription job ID',
    example: '01234567-89ab-cdef-0123-456789abcdef',
  })
  @IsString()
  @IsNotEmpty()
  @IsUUID(7)
  jobId: string;

  @ApiProperty({
    description: 'Transcription text',
  })
  @IsString()
  @IsNotEmpty()
  transcriptText: string;

  @ApiPropertyOptional({
    description: 'Transcription metadata (word timestamps, confidence, etc.)',
  })
  @IsObject()
  @IsOptional()
  metadata?: JsonValue;

  @ApiPropertyOptional({
    description: 'Consultation ID to add the transcript to',
  })
  @IsString()
  @IsOptional()
  @IsUUID(7)
  consultationId?: string;

  @ApiPropertyOptional({
    description: 'Source of the transcription: streaming (WebSocket) or batch (file upload)',
    enum: ['streaming', 'batch'],
    default: 'batch',
  })
  @IsString()
  @IsOptional()
  @IsIn(['streaming', 'batch'])
  transcriptionSource?: 'streaming' | 'batch';
}

/**
 * Request from STT-v2 service to update job progress
 */
export class InternalUpdateProgressRequest {
  @ApiProperty({
    description: 'Job progress (0-100)',
    example: 50,
    minimum: 0,
    maximum: 100,
  })
  @IsNumber()
  @Min(0)
  @Max(100)
  progress: number;
}

/**
 * Request from STT-v2 service to mark job as started
 */
export class InternalStartJobRequest {
  @ApiProperty({
    description: 'Worker ID processing this job',
    example: 'worker-001',
  })
  @IsString()
  @IsNotEmpty()
  workerId: string;
}

/**
 * Request from STT-v2 service to complete a job
 */
export class InternalCompleteJobRequest {
  @ApiProperty({
    description: 'Transcription result text',
  })
  @IsString()
  @IsNotEmpty()
  resultText: string;

  @ApiPropertyOptional({
    description: 'Result metadata (word timestamps, confidence scores, etc.)',
  })
  @IsObject()
  @IsOptional()
  resultMetadata?: JsonValue;
}

/**
 * Request from STT-v2 service to fail a job
 */
export class InternalFailJobRequest {
  @ApiProperty({
    description: 'Error message',
    example: 'Audio file is corrupted',
  })
  @IsString()
  @IsNotEmpty()
  errorMessage: string;

  @ApiPropertyOptional({
    description: 'Error code',
    example: 'AUDIO_CORRUPT',
  })
  @IsString()
  @IsOptional()
  errorCode?: string;
}

/**
 * Request from STT-v2 service to create an audio recording record
 * Called after STT-v2 stores audio blob to MinIO
 */
export class CreateAudioRecordRequest {
  // TASK-334 I-2c — the writer now serves two callers:
  //  • batch/local: `contextItemId` + the storage quartet (creates the Media here)
  //  • streaming dual-capture: `consultationId` (+ `tenantId`) + a pre-registered
  //    `mediaId` (raw/processed Media already created via /internal/stt/media)
  // Hence the previously-required fields are optional; the service enforces
  // "contextItemId OR consultationId" and "mediaId OR storage quartet".
  @ApiPropertyOptional({
    description: 'Context item ID to associate the audio with. Provide this OR consultationId.',
    example: '01234567-89ab-cdef-0123-456789abcdef',
  })
  @IsString()
  @IsOptional()
  @IsUUID()
  contextItemId?: string;

  @ApiPropertyOptional({
    description: 'Consultation ID to attach the recording to (streaming path). Resolves/creates the AUDIO_RECORDING container. Provide this OR contextItemId.',
    example: '01234567-89ab-cdef-0123-456789abcdef',
  })
  @IsString()
  @IsOptional()
  @IsUUID()
  consultationId?: string;

  @ApiPropertyOptional({
    description: 'Owning tenant ID (required when attaching by consultationId).',
  })
  @IsString()
  @IsOptional()
  tenantId?: string;

  @ApiPropertyOptional({
    description: 'Pre-registered primary Media id (streaming dual-capture). Provide this OR the storage quartet.',
    example: '01234567-89ab-cdef-0123-456789abcdef',
  })
  @IsString()
  @IsOptional()
  @IsUUID()
  mediaId?: string;

  @ApiPropertyOptional({
    description: 'MinIO storage path/URI where audio is stored (required when mediaId is absent)',
    example: 'hope-audio/tenant-123/2026/02/consultations/consult-456/audio-789.wav',
  })
  @IsString()
  @IsOptional()
  storagePath?: string;

  @ApiPropertyOptional({
    description: 'Original filename (required when mediaId is absent)',
    example: 'recording.wav',
  })
  @IsString()
  @IsOptional()
  filename?: string;

  @ApiPropertyOptional({
    description: 'File size in bytes (required when mediaId is absent)',
    example: 1048576,
  })
  @IsNumber()
  @IsOptional()
  @Min(1)
  fileSizeBytes?: number;

  @ApiPropertyOptional({
    description: 'MIME type of the audio file (required when mediaId is absent)',
    example: 'audio/wav',
  })
  @IsString()
  @IsOptional()
  mimeType?: string;

  @ApiPropertyOptional({
    description: 'Audio duration in milliseconds',
    example: 60000,
  })
  @IsNumber()
  @IsOptional()
  @Min(0)
  durationMs?: number;

  @ApiPropertyOptional({
    description: 'Sample rate in Hz',
    example: 16000,
  })
  @IsNumber()
  @IsOptional()
  sampleRate?: number;

  @ApiPropertyOptional({
    description: 'Number of audio channels',
    example: 1,
  })
  @IsNumber()
  @IsOptional()
  channels?: number;

  @ApiPropertyOptional({
    description: 'Audio bitrate in kbps',
    example: 128,
  })
  @IsNumber()
  @IsOptional()
  bitrate?: number;

  @ApiPropertyOptional({
    description: 'File hash (SHA256) for verification',
    example: 'a1b2c3d4e5f6...',
  })
  @IsString()
  @IsOptional()
  hash?: string;

  @ApiPropertyOptional({
    description: 'Detected or specified language',
    example: 'en-US',
  })
  @IsString()
  @IsOptional()
  language?: string;

  @ApiPropertyOptional({
    description: 'Sequence number for multi-part recordings',
    example: 1,
    default: 1,
  })
  @IsNumber()
  @IsOptional()
  @Min(1)
  sequenceNumber?: number;

  @ApiPropertyOptional({
    description: 'When the audio was recorded',
    example: '2026-02-02T10:30:00Z',
  })
  @IsOptional()
  recordedAt?: Date;

  @ApiPropertyOptional({
    description: 'Associated transcription job ID',
    example: '01234567-89ab-cdef-0123-456789abcdef',
  })
  @IsString()
  @IsOptional()
  @IsUUID()
  jobId?: string;

  @ApiPropertyOptional({
    description: 'Media ID for the raw (unprocessed) capture (dual-capture path)',
    example: '01234567-89ab-cdef-0123-456789abcdef',
  })
  @IsString()
  @IsOptional()
  @IsUUID()
  rawMediaId?: string;

  @ApiPropertyOptional({
    description: 'Media ID for the processed (noise-filtered) capture (dual-capture path)',
    example: '01234567-89ab-cdef-0123-456789abcdef',
  })
  @IsString()
  @IsOptional()
  @IsUUID()
  processedMediaId?: string;
}

/**
 * Response for created audio record
 */
export class AudioRecordResponse {
  @ApiProperty({ description: 'Audio recording ID' })
  audioRecordingId: string;

  @ApiProperty({ description: 'Media ID' })
  mediaId: string;
}

/**
 * TASK-334 I-2b — Request from STT-v2 to register a stored object as a `Media`
 * row. The streaming dual-capture path uploads raw/processed WAVs to object
 * storage, then calls this to obtain each `Media` id (`rawMediaId` /
 * `processedMediaId`) before creating the `AudioRecording`.
 */
export class InternalCreateMediaRequest {
  @ApiProperty({ description: 'Owning tenant ID' })
  @IsString()
  @IsNotEmpty()
  tenantId: string;

  @ApiProperty({ description: 'Media display name / filename', example: 'session-1-raw.wav' })
  @IsString()
  @IsNotEmpty()
  name: string;

  @ApiProperty({ description: 'Storage URI/key where the object is stored' })
  @IsString()
  @IsNotEmpty()
  uri: string;

  @ApiProperty({ description: 'File extension', example: 'wav' })
  @IsString()
  @IsNotEmpty()
  extension: string;

  @ApiProperty({ description: 'MIME type', example: 'audio/wav' })
  @IsString()
  @IsNotEmpty()
  mimeType: string;

  @ApiProperty({ description: 'File size in bytes', example: 2048 })
  @IsNumber()
  @Min(0)
  size: number;

  @ApiPropertyOptional({ description: 'Content hash (SHA256); empty when unknown', default: '' })
  @IsString()
  @IsOptional()
  hash?: string;

  @ApiPropertyOptional({ description: 'User id that created the capture' })
  @IsString()
  @IsOptional()
  createdBy?: string;
}

/**
 * Response for a created Media row. `id` matches what the STT-v2 client reads
 * back as `rawMediaId`/`processedMediaId`.
 */
export class InternalCreateMediaResponse {
  @ApiProperty({ description: 'Created Media ID' })
  id: string;
}
