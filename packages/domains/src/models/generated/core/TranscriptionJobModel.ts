/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */

import { BaseTenantDataModel, VirtualDbProperty } from '../../../common';
import { JsonValue } from '../../../interfaces';
import * as Enums from '../../../enums';
import * as Models from './';

export class TranscriptionJob extends BaseTenantDataModel {
  public jobType: Enums.TranscriptionJobType;
  public consultationId: string | null;
  public contextItemId: string | null;
  public mediaId: string | null;
  public pipelineId: string | null;
  public agentVersionId: string | null;
  public resolvedSpec: JsonValue | null;
  public dispatchEnvelope: JsonValue | null;
  public status: Enums.TranscriptionJobStatus;
  public progress: number;
  public queuedAt: Date;
  public startedAt: Date | null;
  public completedAt: Date | null;
  // Plaintext resultText / resultMetadata columns DROPPED;
  // persistence is ciphertext-only. The entity keeps these as transient fields
  // repopulated by repository decrypt-on-read.
  // Vault-Transit ciphertext columns + shared key version.
  public encryptedResultText: Uint8Array | null;
  public encryptedResultMetadata: Uint8Array | null;
  public keyVersion: number | null;
  public errorMessage: string | null;
  public errorCode: string | null;
  public retryCount: number;
  public maxRetries: number;
  public reclaimCount: number;
  public workerId: string | null;
  @VirtualDbProperty()
  public Pipeline: Models.AsrPipeline | undefined;

  constructor(data: TranscriptionJob & BaseTenantDataModel) {
    super(data);
    this.jobType = data.jobType;
    this.consultationId = data.consultationId;
    this.contextItemId = data.contextItemId;
    this.mediaId = data.mediaId;
    this.pipelineId = data.pipelineId;
    this.agentVersionId = data.agentVersionId;
    this.resolvedSpec = data.resolvedSpec;
    this.dispatchEnvelope = data.dispatchEnvelope;
    this.status = data.status;
    this.progress = data.progress;
    this.queuedAt = data.queuedAt;
    this.startedAt = data.startedAt;
    this.completedAt = data.completedAt;
    this.encryptedResultText = data.encryptedResultText;
    this.encryptedResultMetadata = data.encryptedResultMetadata;
    this.keyVersion = data.keyVersion;
    this.errorMessage = data.errorMessage;
    this.errorCode = data.errorCode;
    this.retryCount = data.retryCount;
    this.maxRetries = data.maxRetries;
    this.reclaimCount = data.reclaimCount;
    this.workerId = data.workerId;
    this.Pipeline = data.Pipeline;
  }
}
