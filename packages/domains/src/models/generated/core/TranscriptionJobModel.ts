/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class TranscriptionJob extends BaseTenantDataModel {
    public jobType: Enums.TranscriptionJobType;
    public consultationId: string | null;
    public contextItemId: string | null;
    public mediaId: string | null;
    public pipelineId: string;
    public status: Enums.TranscriptionJobStatus;
    public progress: number;
    public queuedAt: Date;
    public startedAt: Date | null;
    public completedAt: Date | null;
    public resultText: string | null;
    public resultMetadata: JsonValue | null;
    public errorMessage: string | null;
    public errorCode: string | null;
    public retryCount: number;
    public maxRetries: number;
    public workerId: string | null;

    // Relations
    public Pipeline?: Models.AsrPipeline;

    constructor(data: TranscriptionJob & BaseTenantDataModel) {
        super(data);
        this.jobType = data.jobType;
        this.consultationId = data.consultationId;
        this.contextItemId = data.contextItemId;
        this.mediaId = data.mediaId;
        this.pipelineId = data.pipelineId;
        this.status = data.status;
        this.progress = data.progress;
        this.queuedAt = data.queuedAt;
        this.startedAt = data.startedAt;
        this.completedAt = data.completedAt;
        this.resultText = data.resultText;
        this.resultMetadata = data.resultMetadata;
        this.errorMessage = data.errorMessage;
        this.errorCode = data.errorCode;
        this.retryCount = data.retryCount;
        this.maxRetries = data.maxRetries;
        this.workerId = data.workerId;
        this.Pipeline = data.Pipeline;
    }
}
