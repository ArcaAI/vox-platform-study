import {
  AiCapability,
  AiCostBasis,
  AiDeploymentKind,
  AiUsageUnit,
  AudioRecordingFactory,
  AudioRecordingRepository,
  ContextItemEntity,
  ContextItemFactory,
  ContextItemRepository,
  ContextItemSource,
  ContextItemType,
  CorePrisma,
  CoreUnitOfWorkService,
  MediaFactory,
  MediaRepository,
  ResourceType,
  SysEventType,
  TranscriptionJobRepository,
  TranscriptSegmentFactory,
  TranscriptSegmentRepository,
} from '@arcaai/domains';
import { BadRequestException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { BaseService, encryptPhiFields, isSttAggregateTranscript, STT_AGGREGATE_SUBTYPE } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';
import { SecretsService } from '../../baseServices/_meta/secrets';
import { IRedisCacheService } from '../../baseServices/redis';
import { ConsultationPipelineEvent, TranscriptionCreatedPayload } from '../../consultation/events';
import { IUsageLedgerService, UsageIdempotencyKey } from '../../usageLedger';
import { TranscriptionJobResponse } from '../job/dto';
import { TranscriptionJobDtoMapper } from '../job/transcriptionJob.dto.mapper';
import { ISttInternalService } from './ISttInternalService';
import { computeSegmentOffsets, type TranscriptSegmentInputShape } from '../../consultation/lib/transcript-segments';
import {
  AudioRecordResponse,
  CreateAudioRecordRequest,
  CreateTranscriptRequest,
  InternalCreateMediaRequest,
  InternalCreateMediaResponse,
  InternalCompleteJobRequest,
  InternalFailJobRequest,
  InternalStartJobRequest,
  InternalUpdateProgressRequest,
} from './dto';

@Injectable()
export class SttInternalService extends BaseService implements ISttInternalService {
  constructor(
    private readonly jobRepository: TranscriptionJobRepository,
    private readonly contextItemRepository: ContextItemRepository,
    private readonly mediaRepository: MediaRepository,
    private readonly audioRecordingRepository: AudioRecordingRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    // Optional + trailing so existing positional fixtures
    // keep their arity; when wired, the completed job's resultText/resultMetadata
    // are encrypted before persist (dual-write soak).
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
    // optional + trailing (same arity-preserving reason) so the
    // ingest can persist per-transcript segments when the repo is wired.
    @Optional()
    @Inject(TranscriptSegmentRepository)
    private readonly transcriptSegmentRepository?: TranscriptSegmentRepository,
    // Optional + trailing (same arity-preserving reason) so
    // existing positional unit fixtures keep their arity. Backs the
    // single-flight idempotency guard around `createStreamingTranscript`
    // (see `withTranscriptIdempotency`). Absent (or a Redis hiccup) ⇒ falls
    // through to the pre-existing `findTranscripts` existence check alone.
    @Optional()
    @Inject(IRedisCacheService)
    private readonly redisCache?: IRedisCacheService,
    // Optional + trailing (same arity-preserving reason).
    // Backs the `transcribe.batch` usage-ledger emission on job completion.
    // This is the DOMAINS `CoreUnitOfWorkService` (its `runInTransaction`
    // is the one production callers actually use — see the outbox drainer),
    // NOT the identically-named, unwired class under `services/baseServices`.
    @Optional() private readonly unitOfWorkService?: CoreUnitOfWorkService,
    @Optional() @Inject(IUsageLedgerService) private readonly usageLedgerService?: IUsageLedgerService,
  ) {
    super(eventEmitter, clsService, ResourceType.TranscriptionJob);
  }

  /**
   * persist the ordered transcript segments emitted by STT as
   * TranscriptSegment rows. `text` on each input is used ONLY to resolve the
   * [charStart, charEnd) offsets into the transcript content and is NOT stored
   * (the durable row keeps offsets + timings + speaker, never the PHI text).
   *
   * Segments arrive either on the typed `dto.segments` field or (D8: stop
   * dropping metadata) embedded as `metadata.segments`. Best-effort: a failure
   * here must not fail the transcript ingest, so it is guarded + logged.
   */
  private async persistTranscriptSegments(contextItem: ContextItemEntity, dto: CreateTranscriptRequest): Promise<void> {
    if (!this.transcriptSegmentRepository) return;

    const metaSegments = (dto.metadata as { segments?: TranscriptSegmentInputShape[] } | undefined)?.segments;
    const rawSegments = dto.segments ?? metaSegments;
    if (!Array.isArray(rawSegments) || rawSegments.length === 0) return;

    try {
      // Report (never silently swallow) a segment that resolved to
      // nothing but its ordinal. That was the defect's whole signature: the batch
      // producer sent a text-less, seconds-based, snake_case shape, every field
      // coerced to null, and the ingest wrote ungroundable rows without a murmur.
      // `computeSegmentOffsets` now normalizes both shapes, so reaching this log
      // means a producer sent something genuinely unusable — alert on it.
      const unusable: number[] = [];
      const resolved = computeSegmentOffsets(dto.transcriptText ?? '', rawSegments, (report) => {
        if (unusable.length === 0) {
          this.logger.error(
            `stt.transcript.segment_shape_unusable — contextItem ${contextItem.id}: segment ` +
              `#${report.position} carries no timing, speaker or offsets after normalization ` +
              `(keys: ${report.keys.join(',') || 'none'}). Evidence grounding will find no source ` +
              `for this transcript; check the stt producer payload shape.`,
          );
        }
        unusable.push(report.position);
      });
      if (unusable.length > 0) {
        this.logger.error(
          `stt.transcript.segment_shape_unusable_total — contextItem ${contextItem.id}: ` +
            `${unusable.length}/${resolved.length} segments unusable.`,
        );
      }
      // Batch-insert in ONE createMany round trip (F-14) instead of one
      // INSERT per segment — dozens to hundreds per consult.
      const entities = resolved.map((seg) =>
        TranscriptSegmentFactory.CreateTranscriptSegment({
          tenantId: contextItem.tenantId ?? dto.tenantId ?? '',
          contextItemId: contextItem.id,
          idx: seg.idx,
          t0Ms: seg.t0Ms,
          t1Ms: seg.t1Ms,
          speaker: seg.speaker,
          charStart: seg.charStart,
          charEnd: seg.charEnd,
          createdBy: contextItem.createdBy ?? undefined,
        }),
      );
      await this.transcriptSegmentRepository.createMany(entities);
    } catch (error) {
      this.logger.error(`TranscriptSegment persist skipped for contextItem ${contextItem.id}: ${(error as Error).message}`);
    }
  }

  private readonly logger = new Logger(SttInternalService.name);

  // Single-flight dedup namespace + TTL for the streaming-transcript create
  // path (F-09). 24h mirrors the harness callback idempotency window
  // (`HarnessInternalService.IDEMPOTENCY_TTL`) — long enough to outlive any
  // realistic outbox re-drive/retry window for a single finalize.
  private readonly TRANSCRIPT_IDEMPOTENCY_KEY_PREFIX = 'idempotency:stt-transcript:';
  private readonly TRANSCRIPT_IDEMPOTENCY_TTL = 86400; // 24 hours
  private readonly TRANSCRIPT_LOCK_WAIT_ATTEMPTS = 3;
  private readonly TRANSCRIPT_LOCK_WAIT_MS = 50;

  /**
   * Encrypt PHI on write through the shared env-gated guard: a soft
   * no-op in dev/test (SECRETS_PROVIDER!=vault) but FAIL-CLOSED (throws) in
   * staging/prod (SECRETS_PROVIDER=vault) instead of persisting plaintext-only.
   */
  private async encryptBestEffort(label: string, run: () => Promise<void>): Promise<void> {
    await encryptPhiFields(this.secretsService, label, run, this.logger);
  }

  /**
   * Derive a stable idempotency key for a streaming-transcript create when
   * the caller sent no `Idempotency-Key` header. Mirrors the key shape
   * STT-v2 already sends (`{consultationId}:{sessionId}`,
   * `session_manager.py:_transcript_idempotency_key`), namespaced by tenant.
   * `sessionId` best-effort read from `metadata` (untyped on the DTO); falls
   * back to `tenantId:consultationId` alone when absent.
   */
  private deriveStreamingIdempotencyKey(dto: CreateTranscriptRequest): string {
    const meta = dto.metadata as Record<string, unknown> | undefined;
    const sessionId = typeof meta?.sessionId === 'string' ? meta.sessionId : '';
    return `${dto.tenantId ?? ''}:${dto.consultationId ?? ''}:${sessionId}`;
  }

  private buildTranscriptIdempotencyKey(tenantId: string, idempotencyKey: string): string {
    return `${this.TRANSCRIPT_IDEMPOTENCY_KEY_PREFIX}${tenantId}:${idempotencyKey}`;
  }

  /**
   * Single-flight guard around `createStreamingTranscript` (F-09): two
   * concurrent finalize calls for the same session (worker restart racing a
   * slow-but-successful call, an outbox re-drive racing the inline attempt)
   * must produce exactly one TRANSCRIPT ContextItem + one
   * `TranscriptionCreated` event.
   *
   *   1. Replay: a prior COMPLETED call's response is cached — return it
   *      without re-running `work`.
   *   2. Lock: a Redis `SET NX` acquires exclusivity for this key. The
   *      winner runs `work` and caches the result. A loser waits briefly for
   *      the winner to finish (polling the cache), then falls through to
   *      `work` regardless — `createStreamingTranscriptInner`'s own
   *      `findTranscripts` existence check is the second layer that returns
   *      the winner's row instead of creating a duplicate.
   *
   * Best-effort: no Redis (or a Redis throw) ⇒ fall through to `work()` —
   * the pre-existing `findTranscripts` check is the sole guard, matching the
   * pre-fix behavior exactly.
   */
  private async withTranscriptIdempotency<T>(tenantId: string, idempotencyKey: string, work: () => Promise<T>): Promise<T> {
    if (!this.redisCache) {
      return work();
    }

    const redisKey = this.buildTranscriptIdempotencyKey(tenantId, idempotencyKey);

    const replay = await this.tryReplayTranscript<T>(redisKey);
    if (replay.hit) {
      return replay.result;
    }

    let acquired = true;
    try {
      const lockResult = await this.redisCache.eval(
        "return redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', ARGV[2])",
        1,
        redisKey,
        'in-flight',
        this.TRANSCRIPT_IDEMPOTENCY_TTL,
      );
      acquired = lockResult === 'OK';
    } catch (error) {
      this.logger.warn({
        message: 'Streaming transcript idempotency lock failed — processing normally',
        idempotencyKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }

    if (!acquired) {
      // Someone else already holds (or just released) the lock. Give the
      // winner a brief head start to finish + cache its response before
      // falling through to `work()` (whose findTranscripts check is the
      // authoritative second layer).
      for (let attempt = 0; attempt < this.TRANSCRIPT_LOCK_WAIT_ATTEMPTS; attempt++) {
        await new Promise((resolve) => setTimeout(resolve, this.TRANSCRIPT_LOCK_WAIT_MS));
        const retry = await this.tryReplayTranscript<T>(redisKey);
        if (retry.hit) {
          return retry.result;
        }
      }
      return work();
    }

    const result = await work();
    try {
      await this.redisCache.setex(redisKey, this.TRANSCRIPT_IDEMPOTENCY_TTL, JSON.stringify({ done: true, result }));
    } catch (error) {
      this.logger.warn({
        message: 'Streaming transcript idempotency record failed — a race may double-create',
        idempotencyKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
    return result;
  }

  /**
   * Read back a completed `withTranscriptIdempotency` response, if any.
   * The lock's `SET NX` sentinel value (`'in-flight'`) is not valid JSON for
   * the `{done:true, result}` envelope, so a JSON parse failure is treated as
   * "not yet complete" rather than an error.
   */
  private async tryReplayTranscript<T>(redisKey: string): Promise<{ hit: true; result: T } | { hit: false }> {
    try {
      const cached = await this.redisCache!.get(redisKey);
      if (cached) {
        const parsed = JSON.parse(cached) as { done?: boolean; result?: T };
        if (parsed?.done) {
          this.logger.log({ message: 'Streaming transcript idempotency hit — replaying prior response', redisKey });
          return { hit: true, result: parsed.result as T };
        }
      }
    } catch {
      // Either a Redis hiccup or the in-flight sentinel (not JSON) — treat
      // both as "no completed response yet".
    }
    return { hit: false };
  }

  /**
   * Create a transcript context item from completed transcription.
   *
   * `idempotencyKey` is the caller-supplied `Idempotency-Key` header
   * (`stt-internal.controller.ts`) — read through from the STT-v2 gateway
   * (`gateway.py` sends `{consultationId}:{sessionId}`), forwarded ONLY to
   * the no-job streaming path, which is the one with a real concurrent-finalize
   * TOCTOU risk (see `createStreamingTranscript`). The batch/job path already
   * has a unique job-scoped write target, so it does not need this guard.
   */
  async createTranscript(dto: CreateTranscriptRequest, idempotencyKey?: string): Promise<{ contextItemId: string }> {
    // Streaming finalize has no TranscriptionJob. When no
    // jobId is supplied, persist the transcript keyed directly to the
    // consultation (+ tenant) and skip the job lookup / setContextItem link-back.
    if (!dto.jobId) {
      return this.createStreamingTranscript(dto, idempotencyKey);
    }

    // Find the job (batch path)
    const job = await this.jobRepository.findById(dto.jobId);
    if (!job) {
      throw new NotFoundException(`Job ${dto.jobId} not found`);
    }

    // Determine consultation ID
    const consultationId = dto.consultationId || job.consultationId;
    if (!consultationId) {
      throw new BadRequestException('Consultation ID is required to create transcript');
    }

    // Create context item for the transcript
    const contextItem = ContextItemFactory.CreateContextItem({
      tenantId: job.tenantId || undefined,
      consultationId,
      type: ContextItemType.TRANSCRIPT,
      source: ContextItemSource.TRANSCRIPTION,
      content: dto.transcriptText,
      createdBy: job.createdBy || undefined,
    });

    // Mark this row as THE aggregate transcript, so a per-segment client write
    // can never be mistaken for it (see `transcript-provenance.ts`).
    contextItem.metaData = { subType: STT_AGGREGATE_SUBTYPE };

    // Encrypt the transcript text into `encryptedContent` before
    // persistence — the plaintext `content` column was dropped by the PHI
    // field-encryption migration, so an unencrypted create silently loses the
    // clinical text at rest (mirrors context.service.ts `encryptContent`).
    await this.encryptBestEffort('ContextItem content', () => this.contextItemRepository.encryptContentIntoEntity(contextItem, this.secretsService!));

    const savedContextItem = await this.contextItemRepository.create(contextItem);

    // persist ordered transcript segments (offsets resolved from text).
    await this.persistTranscriptSegments(savedContextItem, dto);

    // Update job with context item ID
    job.setContextItem(savedContextItem.id);
    await this.jobRepository.update(dto.jobId, job);

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: savedContextItem.id,
      responsibleEntityId: job.createdBy || undefined,
      data: {
        type: 'TRANSCRIPT',
        jobId: dto.jobId,
        consultationId,
      },
    });

    // Emit pipeline event to trigger auto-summary → auto-NER
    this.eventEmitter.emit(ConsultationPipelineEvent.TranscriptionCreated, {
      consultationId,
      tenantId: job.tenantId || '',
      userId: job.createdBy || undefined,
      timestamp: new Date().toISOString(),
      contextItemId: savedContextItem.id,
      jobId: dto.jobId,
      wordCount: dto.transcriptText ? dto.transcriptText.split(/\s+/).filter(Boolean).length : undefined,
      transcriptionSource: dto.transcriptionSource ?? 'batch',
    } satisfies TranscriptionCreatedPayload);

    return { contextItemId: savedContextItem.id };
  }

  /**
   * Persist a streaming-session transcript that has no
   * TranscriptionJob. Keyed directly to the consultation (+ tenant).
   *
   * TWO layers guard against a duplicate TRANSCRIPT ContextItem when two
   * finalize calls for the same session race each other (server restart racing
   * a slow-but-successful call, an outbox re-drive racing the inline attempt):
   *   1. `withTranscriptIdempotency` — a Redis single-flight lock + replayed
   *      response, keyed on the caller's `Idempotency-Key` (falls back to a
   *      derived `tenantId:consultationId:sessionId` key when absent).
   *   2. `findTranscripts` existence check (below) — the original check-then-act
   *      guard, kept as a second layer for when Redis is unwired/unavailable or
   *      the lock race still lets two callers through.
   */
  private async createStreamingTranscript(dto: CreateTranscriptRequest, idempotencyKey?: string): Promise<{ contextItemId: string }> {
    const consultationId = dto.consultationId;
    if (!consultationId) {
      throw new BadRequestException('consultationId is required to create a transcript without a jobId');
    }

    const key = idempotencyKey || this.deriveStreamingIdempotencyKey(dto);
    return this.withTranscriptIdempotency(dto.tenantId ?? consultationId, key, () => this.createStreamingTranscriptInner(dto, consultationId));
  }

  private async createStreamingTranscriptInner(dto: CreateTranscriptRequest, consultationId: string): Promise<{ contextItemId: string }> {
    // Idempotency guard (second layer): if THIS consultation's aggregate
    // transcript already exists, return it without creating a duplicate or
    // re-emitting the pipeline event.
    //
    // Keyed on the aggregate specifically, NOT on `type: TRANSCRIPT` alone:
    // the SDK also writes one TRANSCRIPT row per final utterance, and a
    // type-only guard let the first of those suppress the aggregate — and
    // with it `TranscriptionCreated`, the sole trigger for harness note
    // generation. See `transcript-provenance.ts`.
    const existing = await this.contextItemRepository.findTranscripts(consultationId);
    const existingAggregate = existing.find((item) => isSttAggregateTranscript(item));
    if (existingAggregate) {
      return { contextItemId: existingAggregate.id };
    }

    const contextItem = ContextItemFactory.CreateContextItem({
      tenantId: dto.tenantId || undefined,
      consultationId,
      type: ContextItemType.TRANSCRIPT,
      source: ContextItemSource.TRANSCRIPTION,
      content: dto.transcriptText,
    });

    contextItem.metaData = { subType: STT_AGGREGATE_SUBTYPE };

    // Encrypt the transcript text into `encryptedContent` before
    // persistence — the plaintext `content` column was dropped by the PHI
    // field-encryption migration, so an unencrypted create silently loses the
    // clinical text at rest (mirrors context.service.ts `encryptContent`).
    await this.encryptBestEffort('ContextItem content', () => this.contextItemRepository.encryptContentIntoEntity(contextItem, this.secretsService!));

    const savedContextItem = await this.contextItemRepository.create(contextItem);

    // persist ordered transcript segments (offsets resolved from text).
    await this.persistTranscriptSegments(savedContextItem, dto);

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: savedContextItem.id,
      data: {
        type: 'TRANSCRIPT',
        consultationId,
      },
    });

    // Emit pipeline event to trigger the harness auto-draft (GAP #1).
    this.eventEmitter.emit(ConsultationPipelineEvent.TranscriptionCreated, {
      consultationId,
      tenantId: dto.tenantId || '',
      timestamp: new Date().toISOString(),
      contextItemId: savedContextItem.id,
      wordCount: dto.transcriptText ? dto.transcriptText.split(/\s+/).filter(Boolean).length : undefined,
      transcriptionSource: dto.transcriptionSource ?? 'streaming',
    } satisfies TranscriptionCreatedPayload);

    return { contextItemId: savedContextItem.id };
  }

  /**
   * Start processing a job
   */
  async startJob(jobId: string, dto: InternalStartJobRequest): Promise<TranscriptionJobResponse> {
    const job = await this.jobRepository.findById(jobId);
    if (!job) {
      throw new NotFoundException(`Job ${jobId} not found`);
    }

    job.startProcessing(dto.workerId);
    const updated = await this.jobRepository.update(jobId, job);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: jobId,
      responsibleEntityId: job.createdBy || undefined,
      data: { status: 'PROCESSING', workerId: dto.workerId },
    });

    return TranscriptionJobDtoMapper.toResponse(updated);
  }

  /**
   * Update job progress
   */
  async updateProgress(jobId: string, dto: InternalUpdateProgressRequest): Promise<TranscriptionJobResponse> {
    const job = await this.jobRepository.findById(jobId);
    if (!job) {
      throw new NotFoundException(`Job ${jobId} not found`);
    }

    job.updateProgress(dto.progress);
    const updated = await this.jobRepository.update(jobId, job);

    return TranscriptionJobDtoMapper.toResponse(updated);
  }

  /**
   * Complete a job.
   *
   * When the STT worker sent typed `durationSeconds` +
   * `engine` (both lifted OUT of the soon-to-be-encrypted `resultMetadata`
   * blob — see `InternalCompleteJobRequest`), this also emits ONE
   * `transcribe.batch` `AUDIO_SECOND` usage row through the ledger, in the
   * SAME transaction as the completing write (`updateWithVersion` + `tx`
   * passthrough — ws-b-contract.md That guards both directions: usage
   * lost after a successful call, and usage recorded for a completion that
   * rolled back. `durationSeconds`/`engine` absent (older worker, or a job
   * that decoded no audio) skips emission — never guessed.
   *
   * A metering failure must never fail the caller's request (contract
   * "Frequently-made mistakes"), so `recordUsage` is caught, not propagated;
   * the completing write still commits.
   */
  async completeJob(jobId: string, dto: InternalCompleteJobRequest): Promise<TranscriptionJobResponse> {
    const job = await this.jobRepository.findById(jobId);
    if (!job) {
      throw new NotFoundException(`Job ${jobId} not found`);
    }

    const expectedVersion = job.version;
    job.complete(dto.resultText, dto.resultMetadata);

    // Encrypt resultText/resultMetadata into the ciphertext
    // columns before the completing persist (dual-write; plaintext kept for soak).
    await this.encryptBestEffort('TranscriptionJob', () => this.jobRepository.encryptFieldsIntoEntity(job, this.secretsService!));

    const canEmitUsage = Boolean(
      this.unitOfWorkService && this.usageLedgerService && dto.durationSeconds != null && dto.durationSeconds > 0 && dto.engine,
    );

    let updated;
    if (canEmitUsage) {
      updated = await this.unitOfWorkService!.runInTransaction(async (tx) => {
        const saved = await this.jobRepository.updateWithVersion(jobId, job, expectedVersion, tx);
        await this.emitBatchUsage(jobId, job, dto, tx);
        return saved;
      });
    } else {
      updated = await this.jobRepository.update(jobId, job);
    }

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: jobId,
      responsibleEntityId: job.createdBy || undefined,
      data: { status: 'COMPLETED' },
    });

    return TranscriptionJobDtoMapper.toResponse(updated);
  }

  /**
   * Build and record the `transcribe.batch` `AUDIO_SECOND` usage row.
   * Caller guarantees `dto.durationSeconds > 0` and `dto.engine` present.
   * Never throws — a ledger-side failure is logged and swallowed so it can
   * never roll back the job-completion transaction it rides inside.
   */
  private async emitBatchUsage(
    jobId: string,
    job: { tenantId?: string | null; consultationId?: string | null; pipelineId?: string; completedAt?: Date | null },
    dto: InternalCompleteJobRequest,
    tx: CorePrisma.TransactionClient,
  ): Promise<void> {
    try {
      await this.usageLedgerService!.recordUsage(
        {
          common: {
            tenantId: job.tenantId ?? '',
            idempotencyKey: UsageIdempotencyKey.sttBatchJob(jobId),
            occurredAt: job.completedAt ?? new Date(),
            capability: AiCapability.STT,
            operation: 'transcribe.batch',
            provider: dto.engine!,
            model: null,
            deployment: AiDeploymentKind[dto.deployment ?? 'SELF_HOSTED'],
            ...(dto.deployment === 'BYOK' ? { costBasis: AiCostBasis.BYOK_NOTIONAL } : {}),
            consultationId: job.consultationId ?? null,
            requestId: jobId,
            attributesJson: {
              engine: dto.engine!,
              pipelineId: job.pipelineId ?? null,
              channelCount: 1,
            },
          },
          units: [{ unit: AiUsageUnit.AUDIO_SECOND, quantity: dto.durationSeconds! }],
        },
        tx,
      );
    } catch (error) {
      this.logger.error({
        message: 'stt.batch.usage_emit_failed — job completed but the transcribe.batch usage row was not recorded',
        jobId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  /**
   * Fail a job
   */
  async failJob(jobId: string, dto: InternalFailJobRequest): Promise<TranscriptionJobResponse> {
    const job = await this.jobRepository.findById(jobId);
    if (!job) {
      throw new NotFoundException(`Job ${jobId} not found`);
    }

    job.fail(dto.errorMessage, dto.errorCode);
    const updated = await this.jobRepository.update(jobId, job);

    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: jobId,
      responsibleEntityId: job.createdBy || undefined,
      data: { status: 'FAILED', errorMessage: dto.errorMessage },
    });

    return TranscriptionJobDtoMapper.toResponse(updated);
  }

  /**
   * Get job status (lightweight check for worker cancellation polling)
   */
  async getJobStatus(jobId: string): Promise<{ status: string }> {
    const job = await this.jobRepository.findById(jobId);
    if (!job) {
      throw new NotFoundException(`Job ${jobId} not found`);
    }
    return { status: job.status };
  }

  /**
   * Create an audio recording record
   * Called by STT-v2 after storing audio blob to MinIO
   */
  async createAudioRecord(dto: CreateAudioRecordRequest): Promise<AudioRecordResponse> {
    // Validate the two input shapes up-front (before any side effects, so an
    // invalid request never leaves an orphan container behind).
    if (!dto.contextItemId && !dto.consultationId) {
      throw new BadRequestException('Either contextItemId or consultationId is required');
    }
    const hasStorageObject = Boolean(dto.storagePath && dto.filename && dto.mimeType) && dto.fileSizeBytes != null;
    if (!dto.mediaId && !hasStorageObject) {
      throw new BadRequestException('Either mediaId or (storagePath, filename, fileSizeBytes, mimeType) is required');
    }

    // Resolve the container: explicit contextItemId (batch/local) OR resolve the
    // consultation's AUDIO_RECORDING container (streaming dual-capture, parity
    // with the local path's findOrCreateAudioContainer).
    let contextItemId: string;
    let tenantId: string | undefined;
    if (dto.contextItemId) {
      const contextItem = await this.contextItemRepository.findById(dto.contextItemId);
      if (!contextItem) {
        throw new NotFoundException(`Context item ${dto.contextItemId} not found`);
      }
      contextItemId = dto.contextItemId;
      tenantId = dto.tenantId ?? contextItem.tenantId ?? undefined;
    } else {
      if (!dto.tenantId) {
        throw new BadRequestException('tenantId is required when attaching by consultationId');
      }
      const container = await this.findOrCreateAudioContainer(dto.consultationId as string, dto.tenantId);
      contextItemId = container.id;
      tenantId = dto.tenantId ?? container.tenantId ?? undefined;
    }

    // Resolve the primary Media: a pre-registered mediaId (streaming, where the
    // raw/processed Media were already created via createMedia) wins; otherwise
    // create one from the storage object (batch/local).
    let primaryMediaId: string;
    let extension: string | undefined;
    if (dto.mediaId) {
      primaryMediaId = dto.mediaId;
    } else {
      extension = this.extractExtension(dto.filename as string, dto.mimeType as string);
      const media = MediaFactory.CreateMedia({
        tenantId,
        name: dto.filename as string,
        uri: dto.storagePath as string,
        extension,
        mimeType: dto.mimeType as string,
        size: dto.fileSizeBytes as number,
        hash: dto.hash || '',
      });
      const savedMedia = await this.mediaRepository.create(media);
      primaryMediaId = savedMedia.id;
    }

    // Get next sequence number for this context item
    const sequenceNumber = dto.sequenceNumber || (await this.audioRecordingRepository.getNextSequenceNumber(contextItemId));

    // Create AudioRecording record (links Media to ContextItem with audio metadata)
    const audioRecording = AudioRecordingFactory.CreateAudioRecording({
      tenantId,
      contextItemId,
      mediaId: primaryMediaId,
      rawMediaId: dto.rawMediaId,
      processedMediaId: dto.processedMediaId,
      duration: dto.durationMs,
      format: extension,
      sampleRate: dto.sampleRate,
      channels: dto.channels,
      bitrate: dto.bitrate,
      language: dto.language,
      sequenceNumber,
      recordedAt: dto.recordedAt ? new Date(dto.recordedAt) : new Date(),
    });

    const savedAudioRecording = await this.audioRecordingRepository.create(audioRecording);

    // If associated with a job, update the job's mediaId
    if (dto.jobId) {
      const job = await this.jobRepository.findById(dto.jobId);
      if (job) {
        job.mediaId = primaryMediaId;
        await this.jobRepository.update(dto.jobId, job);
      }
    }

    // For audio records, try to attribute to the job creator if a job is linked
    let audioResponsibleEntityId: string | undefined;
    if (dto.jobId) {
      const relatedJob = await this.jobRepository.findById(dto.jobId).catch(() => null);
      audioResponsibleEntityId = relatedJob?.createdBy || undefined;
    }

    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: savedAudioRecording.id,
      responsibleEntityId: audioResponsibleEntityId,
      data: {
        type: 'AUDIO_RECORDING',
        mediaId: primaryMediaId,
        contextItemId,
        consultationId: dto.consultationId,
        storagePath: dto.storagePath,
      },
    });

    return {
      audioRecordingId: savedAudioRecording.id,
      mediaId: primaryMediaId,
    };
  }

  /**
   * Resolve (or create) the consultation's AUDIO_RECORDING container context
   * item. Mirrors `ContextService.findOrCreateAudioContainer` so the streaming
   * dual-capture path attaches recordings exactly like the local path. Uses the
   * already-injected ContextItemRepository — no cross-service dependency.
   */
  private async findOrCreateAudioContainer(consultationId: string, tenantId: string): Promise<ContextItemEntity> {
    const existing = await this.contextItemRepository.findAudioRecordings(consultationId);
    if (existing.length > 0) {
      return existing[0];
    }
    const container = ContextItemFactory.CreateAudioRecording(tenantId, consultationId);
    return this.contextItemRepository.create(container);
  }

  /**
   * Register a stored object as a Media row.
   *
   * The streaming dual-capture path uploads raw/processed WAVs to object
   * storage and calls this once per capture to obtain the Media ids it then
   * threads onto the AudioRecording. Mirrors the internal Media creation that
   * `createAudioRecord` does from a `storagePath`, but as a standalone step so
   * the caller can register raw and processed independently.
   */
  async createMedia(dto: InternalCreateMediaRequest): Promise<InternalCreateMediaResponse> {
    const media = MediaFactory.CreateMedia({
      tenantId: dto.tenantId,
      name: dto.name,
      uri: dto.uri,
      extension: dto.extension,
      mimeType: dto.mimeType,
      size: dto.size,
      hash: dto.hash || '',
      createdBy: dto.createdBy,
    });

    const savedMedia = await this.mediaRepository.create(media);

    return { id: savedMedia.id };
  }

  /**
   * Extract file extension from filename or mimeType
   */
  private extractExtension(filename: string, mimeType: string): string {
    // Try to get from filename first
    const dotIndex = filename.lastIndexOf('.');
    if (dotIndex > 0) {
      return filename.substring(dotIndex + 1).toLowerCase();
    }

    // Fallback to mimeType mapping
    const mimeToExt: Record<string, string> = {
      'audio/wav': 'wav',
      'audio/x-wav': 'wav',
      'audio/wave': 'wav',
      'audio/webm': 'webm',
      'audio/ogg': 'ogg',
      'audio/mpeg': 'mp3',
      'audio/mp3': 'mp3',
      'audio/mp4': 'm4a',
      'audio/aac': 'aac',
      'audio/flac': 'flac',
    };

    return mimeToExt[mimeType] || 'bin';
  }
}
