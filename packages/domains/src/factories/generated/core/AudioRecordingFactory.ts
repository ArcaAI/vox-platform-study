/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { AudioRecordingEntity, IAudioRecordingEntity } from '../../../entities';

export interface CreateAudioRecordingProps extends BaseEntityFactoryCreateProps {
  contextItemId: IAudioRecordingEntity['contextItemId'];
  mediaId: IAudioRecordingEntity['mediaId'];
  rawMediaId?: IAudioRecordingEntity['rawMediaId'];
  processedMediaId?: IAudioRecordingEntity['processedMediaId'];
  duration?: IAudioRecordingEntity['duration'];
  format?: IAudioRecordingEntity['format'];
  sampleRate?: IAudioRecordingEntity['sampleRate'];
  channels?: IAudioRecordingEntity['channels'];
  bitrate?: IAudioRecordingEntity['bitrate'];
  language?: IAudioRecordingEntity['language'];
  sequenceNumber?: IAudioRecordingEntity['sequenceNumber'];
  recordedAt?: IAudioRecordingEntity['recordedAt'];
  tenantId: IAudioRecordingEntity['tenantId'];

  createdAt?: IAudioRecordingEntity['createdAt'];
}

export class AudioRecordingFactory {
  /**
   * Create an audio recording
   */
  static CreateAudioRecording(props: CreateAudioRecordingProps): AudioRecordingEntity {
    const id = generateId();
    const now = new Date();

    return new AudioRecordingEntity({
      id,

      createdAt: props.createdAt || now,
      updatedAt: now,
      createdBy: null,
      updatedBy: null,

      contextItemId: props.contextItemId,
      mediaId: props.mediaId,
      rawMediaId: props.rawMediaId ?? null,
      processedMediaId: props.processedMediaId ?? null,
      duration: props.duration ?? null,
      format: props.format ?? null,
      sampleRate: props.sampleRate ?? null,
      channels: props.channels ?? null,
      bitrate: props.bitrate ?? null,
      language: props.language ?? null,
      sequenceNumber: props.sequenceNumber ?? 1,
      recordedAt: props.recordedAt ?? null,
      tenantId: props.tenantId,
    });
  }

  /**
   * Create an audio recording with full metadata
   */
  static CreateWithMetadata(
    tenantId: string,
    contextItemId: string,
    mediaId: string,
    metadata: {
      rawMediaId?: string | null;
      processedMediaId?: string | null;
      duration?: number;
      format?: string;
      sampleRate?: number;
      channels?: number;
      bitrate?: number;
      language?: string;
    },
    sequenceNumber: number = 1,
    recordedAt?: Date,
  ): AudioRecordingEntity {
    return this.CreateAudioRecording({
      tenantId,
      contextItemId,
      mediaId,
      rawMediaId: metadata.rawMediaId,
      processedMediaId: metadata.processedMediaId,
      duration: metadata.duration,
      format: metadata.format,
      sampleRate: metadata.sampleRate,
      channels: metadata.channels,
      bitrate: metadata.bitrate,
      language: metadata.language,
      sequenceNumber,
      recordedAt,
    });
  }
}
