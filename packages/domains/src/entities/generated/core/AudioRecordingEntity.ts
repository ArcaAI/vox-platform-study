/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Entities from '../../../entities';

export interface IAudioRecordingEntity extends IBaseTenantEntity {
  contextItemId: string;
  mediaId: string;
  rawMediaId?: string | null;
  processedMediaId?: string | null;
  duration?: number | null;
  format?: string | null;
  sampleRate?: number | null;
  channels?: number | null;
  bitrate?: number | null;
  language?: string | null;
  sequenceNumber: number;
  recordedAt?: Date | null;
  ContextItem?: Entities.ContextItemEntity | null;
}

export class AudioRecordingEntity extends BaseTenantEntity {
  private _contextItemId: IAudioRecordingEntity['contextItemId'];
  private _mediaId: IAudioRecordingEntity['mediaId'];
  private _rawMediaId?: IAudioRecordingEntity['rawMediaId'];
  private _processedMediaId?: IAudioRecordingEntity['processedMediaId'];
  private _duration?: IAudioRecordingEntity['duration'];
  private _format?: IAudioRecordingEntity['format'];
  private _sampleRate?: IAudioRecordingEntity['sampleRate'];
  private _channels?: IAudioRecordingEntity['channels'];
  private _bitrate?: IAudioRecordingEntity['bitrate'];
  private _language?: IAudioRecordingEntity['language'];
  private _sequenceNumber: IAudioRecordingEntity['sequenceNumber'];
  private _recordedAt?: IAudioRecordingEntity['recordedAt'];
  private _ContextItem?: IAudioRecordingEntity['ContextItem'];

  constructor(init: IAudioRecordingEntity) {
    super(init);
    this._contextItemId = init.contextItemId;
    this._mediaId = init.mediaId;
    this._rawMediaId = init.rawMediaId;
    this._processedMediaId = init.processedMediaId;
    this._duration = init.duration;
    this._format = init.format;
    this._sampleRate = init.sampleRate;
    this._channels = init.channels;
    this._bitrate = init.bitrate;
    this._language = init.language;
    this._sequenceNumber = init.sequenceNumber ?? 1;
    this._recordedAt = init.recordedAt;
    this._ContextItem = init.ContextItem;
  }

  get contextItemId(): IAudioRecordingEntity['contextItemId'] {
    return this._contextItemId;
  }

  set contextItemId(value: IAudioRecordingEntity['contextItemId']) {
    this.setProperty('contextItemId', value);
  }

  get mediaId(): IAudioRecordingEntity['mediaId'] {
    return this._mediaId;
  }

  set mediaId(value: IAudioRecordingEntity['mediaId']) {
    this.setProperty('mediaId', value);
  }

  get rawMediaId(): IAudioRecordingEntity['rawMediaId'] {
    return this._rawMediaId;
  }

  set rawMediaId(value: IAudioRecordingEntity['rawMediaId']) {
    this.setProperty('rawMediaId', value);
  }

  get processedMediaId(): IAudioRecordingEntity['processedMediaId'] {
    return this._processedMediaId;
  }

  set processedMediaId(value: IAudioRecordingEntity['processedMediaId']) {
    this.setProperty('processedMediaId', value);
  }

  get duration(): IAudioRecordingEntity['duration'] {
    return this._duration;
  }

  set duration(value: IAudioRecordingEntity['duration']) {
    this.setProperty('duration', value);
  }

  get format(): IAudioRecordingEntity['format'] {
    return this._format;
  }

  set format(value: IAudioRecordingEntity['format']) {
    this.setProperty('format', value);
  }

  get sampleRate(): IAudioRecordingEntity['sampleRate'] {
    return this._sampleRate;
  }

  set sampleRate(value: IAudioRecordingEntity['sampleRate']) {
    this.setProperty('sampleRate', value);
  }

  get channels(): IAudioRecordingEntity['channels'] {
    return this._channels;
  }

  set channels(value: IAudioRecordingEntity['channels']) {
    this.setProperty('channels', value);
  }

  get bitrate(): IAudioRecordingEntity['bitrate'] {
    return this._bitrate;
  }

  set bitrate(value: IAudioRecordingEntity['bitrate']) {
    this.setProperty('bitrate', value);
  }

  get language(): IAudioRecordingEntity['language'] {
    return this._language;
  }

  set language(value: IAudioRecordingEntity['language']) {
    this.setProperty('language', value);
  }

  get sequenceNumber(): IAudioRecordingEntity['sequenceNumber'] {
    return this._sequenceNumber;
  }

  set sequenceNumber(value: IAudioRecordingEntity['sequenceNumber']) {
    this.setProperty('sequenceNumber', value);
  }

  get recordedAt(): IAudioRecordingEntity['recordedAt'] {
    return this._recordedAt;
  }

  set recordedAt(value: IAudioRecordingEntity['recordedAt']) {
    this.setProperty('recordedAt', value);
  }

  get ContextItem(): IAudioRecordingEntity['ContextItem'] {
    return this._ContextItem;
  }

  set ContextItem(value: IAudioRecordingEntity['ContextItem']) {
    this.setProperty('ContextItem', value);
  }

  // ============================================
  // Custom Domain Methods
  // ============================================

  /**
   * Check if this is a mono recording
   */
  get isMono(): boolean {
    return this._channels === 1;
  }

  /**
   * Check if this is a stereo recording
   */
  get isStereo(): boolean {
    return this._channels === 2;
  }

  /**
   * Get duration in seconds
   */
  get durationInSeconds(): number | null {
    return this._duration ? this._duration / 1000 : null;
  }

  /**
   * Get duration formatted as MM:SS
   */
  get durationFormatted(): string | null {
    if (!this._duration) return null;
    const totalSeconds = Math.floor(this._duration / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes.toString().padStart(2, '0')}:${seconds.toString().padStart(2, '0')}`;
  }

  public override validate(): void {
    super.validate();
    if (!this._contextItemId) {
      throw new BusinessException('Context item ID is required');
    }
    if (!this._mediaId) {
      throw new BusinessException('Media ID is required');
    }
    if (this._sequenceNumber < 1) {
      throw new BusinessException('Sequence number must be >= 1');
    }
  }
}
