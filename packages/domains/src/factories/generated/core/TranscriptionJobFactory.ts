/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { generateId } from '../../../utils';
import { BaseEntityFactoryCreateProps } from '../../../common';
import { TranscriptionJobEntity, ITranscriptionJobEntity } from '../../../entities';
import * as Enums from '../../../enums';
import * as Entities from '../../../entities';

export interface CreateTranscriptionJobProps extends BaseEntityFactoryCreateProps {
  tenantId: ITranscriptionJobEntity['tenantId'];
  jobType: ITranscriptionJobEntity['jobType'];
  /** @deprecated TASK-861 — removed in R4. Supply `agentVersionId` + `resolvedSpec` instead. */
  pipelineId?: ITranscriptionJobEntity['pipelineId'];
  /** TASK-861 — the ASR Agent version that will run the job (with its `resolvedSpec` snapshot). */
  agentVersionId?: ITranscriptionJobEntity['agentVersionId'];
  resolvedSpec?: ITranscriptionJobEntity['resolvedSpec'];
  consultationId?: ITranscriptionJobEntity['consultationId'];
  mediaId?: ITranscriptionJobEntity['mediaId'];
  maxRetries?: ITranscriptionJobEntity['maxRetries'];

  createdAt?: ITranscriptionJobEntity['createdAt'];
  updatedAt?: ITranscriptionJobEntity['updatedAt'];
  createdBy?: ITranscriptionJobEntity['createdBy'];
}

export interface CreateBatchJobProps extends Omit<CreateTranscriptionJobProps, 'jobType'> {
  mediaId: string; // Required for batch jobs
}

export interface CreateStreamingJobProps extends Omit<CreateTranscriptionJobProps, 'jobType' | 'mediaId'> {
  // mediaId is optional for streaming
  mediaId?: string;
}

export class TranscriptionJobFactory {
  /**
   * Create a new transcription job
   */
  static CreateTranscriptionJob(props: CreateTranscriptionJobProps): TranscriptionJobEntity {
    const id = generateId();
    const now = new Date();

    return new TranscriptionJobEntity({
      id,

      createdAt: props.createdAt || now,
      updatedAt: props.updatedAt || now,
      createdBy: props.createdBy ?? null,
      updatedBy: null,

      tenantId: props.tenantId,
      jobType: props.jobType,
      pipelineId: props.pipelineId ?? null,
      agentVersionId: props.agentVersionId ?? null,
      resolvedSpec: props.resolvedSpec ?? null,
      consultationId: props.consultationId ?? null,
      mediaId: props.mediaId ?? null,
      status: Enums.TranscriptionJobStatus.QUEUED,
      progress: 0,
      queuedAt: now,
      startedAt: null,
      completedAt: null,
      resultText: null,
      resultMetadata: null,
      errorMessage: null,
      errorCode: null,
      retryCount: 0,
      maxRetries: props.maxRetries ?? 3,
      workerId: null,
    });
  }

  /**
   * Create a batch transcription job (for uploaded files)
   */
  static CreateBatchJob(props: CreateBatchJobProps): TranscriptionJobEntity {
    return this.CreateTranscriptionJob({
      ...props,
      jobType: Enums.TranscriptionJobType.BATCH,
    });
  }

  /**
   * Create a streaming transcription job (for live audio)
   */
  static CreateStreamingJob(props: CreateStreamingJobProps): TranscriptionJobEntity {
    return this.CreateTranscriptionJob({
      ...props,
      jobType: Enums.TranscriptionJobType.STREAMING,
    });
  }
}
