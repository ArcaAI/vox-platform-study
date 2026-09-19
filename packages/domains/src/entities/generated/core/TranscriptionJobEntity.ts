/* eslint-disable unused-imports/no-unused-imports */
/* eslint-disable @typescript-eslint/no-unused-vars */
/* eslint-disable @typescript-eslint/no-explicit-any */
import { BusinessException, InvalidStateTransitionException } from '@arcaai/exceptions';
import { BaseTenantEntity, IBaseTenantEntity, Secret } from '../../../common';
import * as Entities from '../../../entities';
import * as Enums from '../../../enums';
import { JsonValue } from '../../../interfaces';

export interface ITranscriptionJobEntity extends IBaseTenantEntity {
  jobType: Enums.TranscriptionJobType;
  consultationId?: string | null;
  contextItemId?: string | null;
  mediaId?: string | null;
  /** @deprecated TASK-861 — removed in R4. The `AsrPipeline` that ran the job; `null` on agent-keyed jobs. */
  pipelineId?: string | null;
  /** TASK-861 — the ASR Agent VERSION (`Agent.id`, rows are versions) that ran the job. No FK. */
  agentVersionId?: string | null;
  /** TASK-861 — the `ResolvedAsrSpec` snapshot the gateway handed to the worker (never a credential). */
  resolvedSpec?: JsonValue | null;
  status: Enums.TranscriptionJobStatus;
  progress: number;
  queuedAt: Date;
  startedAt?: Date | null;
  completedAt?: Date | null;
  resultText?: string | null;
  resultMetadata?: JsonValue | null;
  // Vault-Transit (hope-phi) ciphertext of the result
  // fields + shared key version. Phase 6 dropped the plaintext columns;
  // plaintext survives only as transient fields repopulated by decrypt-on-read.
  encryptedResultText?: Buffer | null;
  encryptedResultMetadata?: Buffer | null;
  keyVersion?: number | null;
  errorMessage?: string | null;
  errorCode?: string | null;
  retryCount: number;
  maxRetries: number;
  /**
   * TASK-992 — how many times this job has been RECLAIMED from a worker that
   * died mid-flight. Deliberately separate from `retryCount` (OD-2): a crashed
   * worker and a transcription that genuinely failed are different events, and
   * sharing one budget means an OOM spends the allowance a bad audio file
   * needs. The bound is `stt.batch.maxReclaims` (global-kv), passed in.
   */
  reclaimCount: number;
  workerId?: string | null;
  /** @deprecated TASK-861 — removed in R4 with `AsrPipeline`. */
  Pipeline?: Entities.AsrPipelineEntity | null;
}

export class TranscriptionJobEntity extends BaseTenantEntity {
  private _jobType: ITranscriptionJobEntity['jobType'];
  private _consultationId?: ITranscriptionJobEntity['consultationId'];
  private _contextItemId?: ITranscriptionJobEntity['contextItemId'];
  private _mediaId?: ITranscriptionJobEntity['mediaId'];
  private _pipelineId?: ITranscriptionJobEntity['pipelineId'];
  private _agentVersionId?: ITranscriptionJobEntity['agentVersionId'];
  private _resolvedSpec?: ITranscriptionJobEntity['resolvedSpec'];
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
  private _reclaimCount: ITranscriptionJobEntity['reclaimCount'];
  private _workerId?: ITranscriptionJobEntity['workerId'];
  private _Pipeline?: ITranscriptionJobEntity['Pipeline'];

  constructor(init: ITranscriptionJobEntity) {
    super(init);
    this._jobType = init.jobType;
    this._consultationId = init.consultationId;
    this._contextItemId = init.contextItemId;
    this._mediaId = init.mediaId;
    this._pipelineId = init.pipelineId;
    this._agentVersionId = init.agentVersionId;
    this._resolvedSpec = init.resolvedSpec;
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
    this._reclaimCount = init.reclaimCount;
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

  /** @deprecated TASK-861 — removed in R4. Read `agentVersionId` / `resolvedSpec` for agent-keyed jobs. */
  get pipelineId(): ITranscriptionJobEntity['pipelineId'] {
    return this._pipelineId;
  }

  set pipelineId(value: ITranscriptionJobEntity['pipelineId']) {
    this.setProperty('pipelineId', value);
  }

  get agentVersionId(): ITranscriptionJobEntity['agentVersionId'] {
    return this._agentVersionId;
  }

  set agentVersionId(value: ITranscriptionJobEntity['agentVersionId']) {
    this.setProperty('agentVersionId', value);
  }

  // The resolved spec is operational metadata, not PHI — but it is still
  // never a credential (provider overrides travel out-of-band).
  get resolvedSpec(): ITranscriptionJobEntity['resolvedSpec'] {
    return this._resolvedSpec;
  }

  set resolvedSpec(value: ITranscriptionJobEntity['resolvedSpec']) {
    this.setProperty('resolvedSpec', value);
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

  // Free-text clinical PHI. @Secret() marks it for
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

  // Vault-Transit ciphertext columns. @Secret() guards the
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

  get reclaimCount(): ITranscriptionJobEntity['reclaimCount'] {
    return this._reclaimCount;
  }

  set reclaimCount(value: ITranscriptionJobEntity['reclaimCount']) {
    this.setProperty('reclaimCount', value);
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
   * TASK-992 — is this job PAST every transition, for good?
   *
   * Narrower than {@link isTerminal} on purpose, and the difference is the
   * whole point: `isTerminal` counts FAILED, but a FAILED job with retries
   * left is re-attemptable ({@link reattemptAfterFailure}), so telling a
   * worker it is finished would silently disable the broker's retry — which is
   * exactly what used to happen. Only these three admit nothing further.
   */
  private get isClaimTerminal(): boolean {
    return this.isCompleted || this.isCancelled || this.isDead;
  }

  /**
   * TASK-992 — the ONE place a refused transition is turned into an error.
   *
   * Every refusal carries the status it refused and whether that status is
   * final, so a caller in another process decides from `metadata`, never from
   * the message. The message is kept byte-identical to the old
   * `BusinessException` text so the deprecated substring branch in the STT
   * client (`gateway.py`) keeps working through a rolling deploy.
   */
  private refuseTransition(attempted: string, verb: string): never {
    throw new InvalidStateTransitionException(`Cannot ${verb} job in ${this._status} status`, {
      entity: 'TranscriptionJob',
      entityId: this.id,
      currentStatus: this._status,
      attempted,
      terminal: this.isClaimTerminal,
    });
  }

  /**
   * Start processing the job
   */
  public startProcessing(workerId: string): void {
    if (!this.isQueued) {
      this.refuseTransition('startProcessing', 'start');
    }
    this.setProperty('status', Enums.TranscriptionJobStatus.PROCESSING);
    this.setProperty('startedAt', new Date());
    this.setProperty('workerId', workerId);
    this.setProperty('progress', 0);
  }

  /**
   * TASK-992 — take over a job whose worker died mid-flight.
   *
   * The broker redelivered the SAME message to a new worker, which is the
   * recovery path working as designed; before this, the gateway refused the
   * new worker's `/start` and the row sat in PROCESSING forever.
   *
   * The gate is worker IDENTITY, not wall clock. Dramatiq's Redis broker only
   * requeues after declaring the prior consumer dead, and `time_limit` hard-
   * bounds any attempt somehow still running — whereas a staleness window long
   * enough to be safe against a live worker (the observed crash happened
   * during diarization, which emits no progress for minutes) is longer than
   * the redelivered worker's entire retry backoff. Wall clock belongs to the
   * reaper, which handles the case where no redelivery ever arrives.
   *
   * `maxReclaims` is passed in rather than read from a sibling column: it is a
   * platform threshold (`stt.batch.maxReclaims`, global-kv), not a property of
   * this row. Past it, the caller marks the job DEAD — a crash-loop must
   * terminate somewhere.
   */
  public reclaimProcessing(workerId: string, maxReclaims: number): void {
    if (!this.isProcessing) {
      this.refuseTransition('reclaimProcessing', 'reclaim');
    }
    if (this._workerId === workerId) {
      this.refuseTransition('reclaimProcessing', 'reclaim');
    }
    if (this._reclaimCount >= maxReclaims) {
      this.refuseTransition('reclaimProcessing', 'reclaim');
    }
    this.setProperty('reclaimCount', this._reclaimCount + 1);
    this.setProperty('workerId', workerId);
    this.setProperty('startedAt', new Date());
    // The dead worker's progress measured work whose output died with it.
    this.setProperty('progress', 0);
  }

  /**
   * TASK-992 — re-run a job the worker already marked FAILED.
   *
   * `transcribe_file` fails the job and THEN re-raises for the broker to
   * retry. The retry re-enters the actor and calls `/start`, so without this
   * transition every retry was refused and ACKed: the actor's `max_retries=3`
   * had never once produced a re-attempt.
   *
   * Unlike a reclaim, this DOES spend `retryCount` — the previous attempt was
   * a genuine transcription failure, which is exactly what that budget counts.
   */
  public reattemptAfterFailure(workerId: string): void {
    if (!this.isFailed) {
      this.refuseTransition('reattemptAfterFailure', 'restart');
    }
    if (this._retryCount >= this._maxRetries) {
      this.refuseTransition('reattemptAfterFailure', 'restart');
    }
    this.setProperty('retryCount', this._retryCount + 1);
    this.setProperty('status', Enums.TranscriptionJobStatus.PROCESSING);
    this.setProperty('startedAt', new Date());
    this.setProperty('workerId', workerId);
    this.setProperty('progress', 0);
    // A running job carrying the previous attempt's error is a lie to every
    // reader of the row — the console, the SDK poll, and the reaper alike.
    this.setProperty('completedAt', null);
    this.setProperty('errorMessage', null);
    this.setProperty('errorCode', null);
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
      this.refuseTransition('complete', 'complete');
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
      this.refuseTransition('fail', 'fail');
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
      this.refuseTransition('cancel', 'cancel');
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
    // TASK-861 — a job is attributable to EXACTLY the thing that ran it: the
    // agent version (+ its resolved spec, so the job is reproducible from its
    // own row) or, for the deprecation window, the legacy pipeline row.
    if (!this._pipelineId && !this._agentVersionId) {
      throw new BusinessException('Either agentVersionId or pipelineId is required');
    }
    if (this._agentVersionId && !this._resolvedSpec) {
      throw new BusinessException('resolvedSpec is required when agentVersionId is set');
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
