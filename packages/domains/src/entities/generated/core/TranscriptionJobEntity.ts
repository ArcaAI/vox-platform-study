/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity, Secret } from '../../../common';
import * as Entities from '../../../entities';
import * as Enums from '../../../enums';
import { JsonValue } from '../../../interfaces';

export interface ITranscriptionJobEntity extends IBaseTenantEntity {
  jobType: Enums.TranscriptionJobType;
  consultationId?: string | null;
  contextItemId?: string | null;
  mediaId?: string | null;
  pipelineId: string;
  status: Enums.TranscriptionJobStatus;
  progress: number;
  queuedAt: Date;
  startedAt?: Date | null;
  completedAt?: Date | null;
  resultText?: string | null;
  resultMetadata?: JsonValue | null;
  // TASK-369 Phase 3C — Vault-Transit (hope-phi) ciphertext of the result
  // fields + shared key version. Phase 6 dropped the plaintext columns;
  // plaintext survives only as transient fields repopulated by decrypt-on-read.
  encryptedResultText?: Buffer | null;
  encryptedResultMetadata?: Buffer | null;
  keyVersion?: number | null;
  errorMessage?: string | null;
  errorCode?: string | null;
  retryCount: number;
  maxRetries: number;
  workerId?: string | null;
  Pipeline?: Entities.AsrPipelineEntity | null;
}

export class TranscriptionJobEntity extends BaseTenantEntity {
  private _jobType: ITranscriptionJobEntity['jobType'];
  private _consultationId?: ITranscriptionJobEntity['consultationId'];
  private _contextItemId?: ITranscriptionJobEntity['contextItemId'];
  private _mediaId?: ITranscriptionJobEntity['mediaId'];
  private _pipelineId: ITranscriptionJobEntity['pipelineId'];
  private _status: ITranscriptionJobEntity['status'];
  private _progress: ITranscriptionJobEntity['progress'];
  private _queuedAt: ITranscriptionJobEntity['queuedAt'];
  private _startedAt?: ITranscriptionJobEntity['startedAt'];
  private _completedAt?: ITranscriptionJobEntity['completedAt'];
  private _resultText?: ITranscriptionJobEntity['resultText'];
  private _resultMetadata?: ITranscriptionJobEntity['resultMetadata'];
  private _encryptedResultText?: ITranscriptionJobEntity['encryptedResultText'];
  private _encryptedResultMetadata?: ITranscriptionJobEntity['encryptedResultMetadata'];
  private _keyVersion?: ITranscriptionJobEntity['keyVersion'];
  private _errorMessage?: ITranscriptionJobEntity['errorMessage'];
  private _errorCode?: ITranscriptionJobEntity['errorCode'];
  private _retryCount: ITranscriptionJobEntity['retryCount'];
  private _maxRetries: ITranscriptionJobEntity['maxRetries'];
  private _workerId?: ITranscriptionJobEntity['workerId'];
  private _Pipeline?: ITranscriptionJobEntity['Pipeline'];

  constructor(init: ITranscriptionJobEntity) {
    super(init);
    this._jobType = init.jobType;
    this._consultationId = init.consultationId;
    this._contextItemId = init.contextItemId;
    this._mediaId = init.mediaId;
    this._pipelineId = init.pipelineId;
    this._status = init.status;
    this._progress = init.progress;
    this._queuedAt = init.queuedAt;
    this._startedAt = init.startedAt;
    this._completedAt = init.completedAt;
    this._resultText = init.resultText;
    this._resultMetadata = init.resultMetadata;
    this._encryptedResultText = init.encryptedResultText;
    this._encryptedResultMetadata = init.encryptedResultMetadata;
    this._keyVersion = init.keyVersion;
    this._errorMessage = init.errorMessage;
    this._errorCode = init.errorCode;
    this._retryCount = init.retryCount;
    this._maxRetries = init.maxRetries;
    this._workerId = init.workerId;
    this._Pipeline = init.Pipeline;
  }

  // Getters and Setters
  get jobType(): ITranscriptionJobEntity['jobType'] {
    return this._jobType;
  }

  set jobType(value: ITranscriptionJobEntity['jobType']) {
    this.setProperty('jobType', value);
  }

  get consultationId(): ITranscriptionJobEntity['consultationId'] {
    return this._consultationId;
  }

  set consultationId(value: ITranscriptionJobEntity['consultationId']) {
    this.setProperty('consultationId', value);
  }

  get contextItemId(): ITranscriptionJobEntity['contextItemId'] {
    return this._contextItemId;
  }

  set contextItemId(value: ITranscriptionJobEntity['contextItemId']) {
    this.setProperty('contextItemId', value);
  }

  get mediaId(): ITranscriptionJobEntity['mediaId'] {
    return this._mediaId;
  }

  set mediaId(value: ITranscriptionJobEntity['mediaId']) {
    this.setProperty('mediaId', value);
  }

  get pipelineId(): ITranscriptionJobEntity['pipelineId'] {
    return this._pipelineId;
  }

  set pipelineId(value: ITranscriptionJobEntity['pipelineId']) {
    this.setProperty('pipelineId', value);
  }

  get status(): ITranscriptionJobEntity['status'] {
    return this._status;
  }

  set status(value: ITranscriptionJobEntity['status']) {
    this.setProperty('status', value);
  }

  get progress(): ITranscriptionJobEntity['progress'] {
    return this._progress;
  }

  set progress(value: ITranscriptionJobEntity['progress']) {
    this.setProperty('progress', value);
  }

  get queuedAt(): ITranscriptionJobEntity['queuedAt'] {
    return this._queuedAt;
  }

  set queuedAt(value: ITranscriptionJobEntity['queuedAt']) {
    this.setProperty('queuedAt', value);
  }

  get startedAt(): ITranscriptionJobEntity['startedAt'] {
    return this._startedAt;
  }

  set startedAt(value: ITranscriptionJobEntity['startedAt']) {
    this.setProperty('startedAt', value);
  }

  get completedAt(): ITranscriptionJobEntity['completedAt'] {
    return this._completedAt;
  }

  set completedAt(value: ITranscriptionJobEntity['completedAt']) {
    this.setProperty('completedAt', value);
  }

  // TASK-369 Phase 3C — free-text clinical PHI. @Secret() marks it for
  // audit-log redaction (defense-in-depth) alongside the encrypted counterpart.
  @Secret()
  get resultText(): ITranscriptionJobEntity['resultText'] {
    return this._resultText;
  }

  set resultText(value: ITranscriptionJobEntity['resultText']) {
    this.setProperty('resultText', value);
  }

  @Secret()
  get resultMetadata(): ITranscriptionJobEntity['resultMetadata'] {
    return this._resultMetadata;
  }

  set resultMetadata(value: ITranscriptionJobEntity['resultMetadata']) {
    this.setProperty('resultMetadata', value);
  }

  // TASK-369 Phase 3C — Vault-Transit ciphertext columns. @Secret() guards the
  // ciphertext from audit-log surfaces.
  @Secret()
  get encryptedResultText(): ITranscriptionJobEntity['encryptedResultText'] {
    return this._encryptedResultText;
  }

  set encryptedResultText(value: ITranscriptionJobEntity['encryptedResultText']) {
    this.setProperty('encryptedResultText', value);
  }

  @Secret()
  get encryptedResultMetadata(): ITranscriptionJobEntity['encryptedResultMetadata'] {
    return this._encryptedResultMetadata;
  }

  set encryptedResultMetadata(value: ITranscriptionJobEntity['encryptedResultMetadata']) {
    this.setProperty('encryptedResultMetadata', value);
  }

  get keyVersion(): ITranscriptionJobEntity['keyVersion'] {
    return this._keyVersion;
  }

  set keyVersion(value: ITranscriptionJobEntity['keyVersion']) {
    this.setProperty('keyVersion', value);
  }

  get errorMessage(): ITranscriptionJobEntity['errorMessage'] {
    return this._errorMessage;
  }

  set errorMessage(value: ITranscriptionJobEntity['errorMessage']) {
    this.setProperty('errorMessage', value);
  }

  get errorCode(): ITranscriptionJobEntity['errorCode'] {
    return this._errorCode;
  }

  set errorCode(value: ITranscriptionJobEntity['errorCode']) {
    this.setProperty('errorCode', value);
  }

  get retryCount(): ITranscriptionJobEntity['retryCount'] {
    return this._retryCount;
  }

  set retryCount(value: ITranscriptionJobEntity['retryCount']) {
    this.setProperty('retryCount', value);
  }

  get maxRetries(): ITranscriptionJobEntity['maxRetries'] {
    return this._maxRetries;
  }

  set maxRetries(value: ITranscriptionJobEntity['maxRetries']) {
    this.setProperty('maxRetries', value);
  }

  get workerId(): ITranscriptionJobEntity['workerId'] {
    return this._workerId;
  }

  set workerId(value: ITranscriptionJobEntity['workerId']) {
    this.setProperty('workerId', value);
  }

  get Pipeline(): ITranscriptionJobEntity['Pipeline'] {
    return this._Pipeline;
  }

  set Pipeline(value: ITranscriptionJobEntity['Pipeline']) {
    this.setProperty('Pipeline', value);
  }

  // ============================================
  // Custom Domain Methods
  // ============================================

  /**
   * Check if this is a batch transcription job
   */
  get isBatch(): boolean {
    return this._jobType === Enums.TranscriptionJobType.BATCH;
  }

  /**
   * Check if this is a streaming transcription job
   */
  get isStreaming(): boolean {
    return this._jobType === Enums.TranscriptionJobType.STREAMING;
  }

  /**
   * Check if job is queued
   */
  get isQueued(): boolean {
    return this._status === Enums.TranscriptionJobStatus.QUEUED;
  }

  /**
   * Check if job is currently processing
   */
  get isProcessing(): boolean {
    return this._status === Enums.TranscriptionJobStatus.PROCESSING;
  }

  /**
   * Check if job completed successfully
   */
  get isCompleted(): boolean {
    return this._status === Enums.TranscriptionJobStatus.COMPLETED;
  }

  /**
   * Check if job failed
   */
  get isFailed(): boolean {
    return this._status === Enums.TranscriptionJobStatus.FAILED;
  }

  /**
   * Check if job was cancelled
   */
  get isCancelled(): boolean {
    return this._status === Enums.TranscriptionJobStatus.CANCELLED;
  }

  /**
   * Check if job is dead (max retries exceeded)
   */
  get isDead(): boolean {
    return this._status === Enums.TranscriptionJobStatus.DEAD;
  }

  /**
   * Check if job is in a terminal state (completed, failed, cancelled, dead)
   */
  get isTerminal(): boolean {
    return this.isCompleted || this.isFailed || this.isCancelled || this.isDead;
  }

  /**
   * Check if job can be retried
   */
  get canRetry(): boolean {
    return this._retryCount < this._maxRetries && this.isFailed;
  }

  /**
   * Get the duration of the job (if completed or failed)
   */
  get durationMs(): number | null {
    if (this._startedAt && this._completedAt) {
      return this._completedAt.getTime() - this._startedAt.getTime();
    }
    return null;
  }

  /**
   * Get the wait time before job started processing
   */
  get waitTimeMs(): number | null {
    if (this._startedAt) {
      return this._startedAt.getTime() - this._queuedAt.getTime();
    }
    return null;
  }

  /**
   * Start processing the job
   */
  public startProcessing(workerId: string): void {
    if (!this.isQueued) {
      throw new BusinessException(`Cannot start job in ${this._status} status`);
    }
    this.setProperty('status', Enums.TranscriptionJobStatus.PROCESSING);
    this.setProperty('startedAt', new Date());
    this.setProperty('workerId', workerId);
    this.setProperty('progress', 0);
  }

  /**
   * Update job progress (0-100)
   */
  public updateProgress(progress: number): void {
    if (progress < 0 || progress > 100) {
      throw new BusinessException('Progress must be between 0 and 100');
    }
    this.setProperty('progress', progress);
  }

  /**
   * Mark job as completed with results
   */
  public complete(resultText: string, resultMetadata?: JsonValue): void {
    if (!this.isProcessing) {
      throw new BusinessException(`Cannot complete job in ${this._status} status`);
    }
    this.setProperty('status', Enums.TranscriptionJobStatus.COMPLETED);
    this.setProperty('completedAt', new Date());
    this.setProperty('progress', 100);
    this.setProperty('resultText', resultText);
    if (resultMetadata !== undefined) {
      this.setProperty('resultMetadata', resultMetadata);
    }
  }

  /**
   * Mark job as failed
   */
  public fail(errorMessage: string, errorCode?: string): void {
    if (this.isTerminal) {
      throw new BusinessException(`Cannot fail job in ${this._status} status`);
    }
    this.setProperty('status', Enums.TranscriptionJobStatus.FAILED);
    this.setProperty('completedAt', new Date());
    this.setProperty('errorMessage', errorMessage);
    if (errorCode) {
      this.setProperty('errorCode', errorCode);
    }
  }

  /**
   * Increment retry count and return whether retry is allowed
   */
  public incrementRetry(): boolean {
    if (!this.canRetry) {
      return false;
    }
    this.setProperty('retryCount', this._retryCount + 1);
    this.setProperty('status', Enums.TranscriptionJobStatus.QUEUED);
    this.setProperty('startedAt', null);
    this.setProperty('completedAt', null);
    this.setProperty('progress', 0);
    this.setProperty('workerId', null);
    this.setProperty('errorMessage', null);
    this.setProperty('errorCode', null);
    return true;
  }

  /**
   * Mark job as dead (max retries exceeded)
   */
  public markAsDead(): void {
    this.setProperty('status', Enums.TranscriptionJobStatus.DEAD);
    this.setProperty('completedAt', new Date());
  }

  /**
   * Cancel the job
   */
  public cancel(): void {
    if (this.isTerminal) {
      throw new BusinessException(`Cannot cancel job in ${this._status} status`);
    }
    this.setProperty('status', Enums.TranscriptionJobStatus.CANCELLED);
    this.setProperty('completedAt', new Date());
  }

  /**
   * Set the context item ID (after transcript is created)
   */
  public setContextItem(contextItemId: string): void {
    this.setProperty('contextItemId', contextItemId);
  }

  public override validate(): void {
    super.validate();
    if (!this._pipelineId) {
      throw new BusinessException('Pipeline ID is required');
    }
    if (this._progress < 0 || this._progress > 100) {
      throw new BusinessException('Progress must be between 0 and 100');
    }
    if (this._retryCount < 0) {
      throw new BusinessException('Retry count cannot be negative');
    }
    if (this._maxRetries < 0) {
      throw new BusinessException('Max retries cannot be negative');
    }
  }
}
