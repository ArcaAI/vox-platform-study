/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel } from '../../../common';
import * as Models from './';

export class AudioRecording extends BaseTenantDataModel {
    public contextItemId: string;
    public mediaId: string;
    public duration: number | null;
    public format: string | null;
    public sampleRate: number | null;
    public channels: number | null;
    public bitrate: number | null;
    public language: string | null;
    public sequenceNumber: number;
    public recordedAt: Date | null;

    constructor(data: AudioRecording & BaseTenantDataModel) {
        super(data);
        this.contextItemId = data.contextItemId;
        this.mediaId = data.mediaId;
        this.duration = data.duration;
        this.format = data.format;
        this.sampleRate = data.sampleRate;
        this.channels = data.channels;
        this.bitrate = data.bitrate;
        this.language = data.language;
        this.sequenceNumber = data.sequenceNumber ?? 1;
        this.recordedAt = data.recordedAt;
    }
}
