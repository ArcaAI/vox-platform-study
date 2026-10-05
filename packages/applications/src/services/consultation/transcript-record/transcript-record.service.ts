import { createHash } from 'node:crypto';
import {
  AudioRecordingRepository,
  ConsultationEntity,
  ConsultationRepository,
  ConsultationStatus,
  ContextItemEntity,
  ContextItemFactory,
  ContextItemRepository,
  ContextItemSource,
  ContextItemType,
  ContextItemVersionEntity,
  ContextItemVersionFactory,
  ContextItemVersionRepository,
  CoreUnitOfWorkService,
  ResourceType,
  SysEventType,
  TranscriptionJobRepository,
} from '@arcaai/domains';
import { BadRequestException, Inject, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { BaseService, encryptPhiFields } from '../../../common';
import { IActiveUserContext } from '../../../interfaces';
import { SecretsService, parseKeyVersionFromCiphertext } from '../../baseServices/_meta/secrets';
import { IRedisCacheService } from '../../baseServices/redis';
import { countTranscriptWords } from '../../stt/transcript-size';
import { stampContentCounters } from '../shared/contentCounters';
import {
  ConsultationPipelineEvent,
  EncounterStoppedPayload,
  FullTranscriptRebuiltPayload,
  TranscriptionCreatedPayload,
} from '../events';
import { IngestSegment, IngestSegmentsInput, IngestSegmentsResult, ITranscriptRecordService } from './ITranscriptRecordService';
import {
  encounterStoppedRedisKey,
  segmentKeyOf,
  sttFinalRedisKey,
  sttStreamRunKey,
  TRANSCRIPT_RECORD_MARKER_TTL_SECONDS,
} from './transcript-record.keys';

/** One part of the consultation recording, in timeline order. */
export interface RecordingManifestPart {
  audioRecordingId: string;
  mediaId: string;
  encounterSeq: number;
  sttSessionId: string | null;
  /** Position on the consultation-wide recording timeline. */
  startMs: number;
  durationMs: number;
}

/** `metaData.manifest` of the AUDIO_RECORDING item and of each of its versions. */
export interface RecordingManifest {
  codec: string | null;
  totalMs: number;
  parts: RecordingManifestPart[];
}

interface VersionWrite {
  changeSource: string;
  changeReason: string;
  changedBy: string;
  metaData?: Record<string, unknown>;
}

const AWAIT_FINAL_POLL_MS = 200;

type Tx = unknown;

/**
 * Owns the consultation record built from speech. Every write goes through the domain
 * repositories; the consultation's activity, sequence and cursor columns move through the
 * no-version-bump writers so a client's If-Match survives the churn.
 */
@Injectable()
export class TranscriptRecordService extends BaseService implements ITranscriptRecordService {
  private readonly logger = new Logger(TranscriptRecordService.name);

  constructor(
    private readonly contextItemRepository: ContextItemRepository,
    private readonly contextItemVersionRepository: ContextItemVersionRepository,
    private readonly consultationRepository: ConsultationRepository,
    private readonly transcriptionJobRepository: TranscriptionJobRepository,
    private readonly audioRecordingRepository: AudioRecordingRepository,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
    @Optional() @Inject(SecretsService) private readonly secretsService?: SecretsService,
    @Optional() @Inject(IRedisCacheService) private readonly redisCache?: IRedisCacheService,
    @Optional() private readonly unitOfWorkService?: CoreUnitOfWorkService,
  ) {
    super(eventEmitter, clsService, ResourceType.ContextItem);
  }

  // ===========================================================================
  // Segments
  // ===========================================================================

  async ingestSegments(input: IngestSegmentsInput): Promise<IngestSegmentsResult> {
    if (!input.tenantId || !input.consultationId || !input.sttSessionId) {
      throw new BadRequestException('tenantId, consultationId and sttSessionId are required');
    }
    const consultation = await this.loadConsultation(input.consultationId, input.tenantId);
    await this.consultationRepository.touchActivity(consultation.id);

    const segments = input.segments ?? [];
    if (segments.length === 0) {
      return { accepted: 0, duplicates: 0, lastSegmentSeq: consultation.segmentSeqHead };
    }

    // In-batch replays first, then keys already stored: neither may consume a sequence number.
    const byIndex = new Map<number, IngestSegment>();
    for (const segment of segments) {
      if (!byIndex.has(segment.utteranceIndex)) byIndex.set(segment.utteranceIndex, segment);
    }
    const unique = [...byIndex.values()].sort((a, b) => a.utteranceIndex - b.utteranceIndex);
    const keys = unique.map((s) => segmentKeyOf(input.sttSessionId, s.utteranceIndex));
    const stored = await this.contextItemRepository.findAll({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      filters: { consultationId: consultation.id, segmentKey: { in: keys } } as any,
    });
    const storedKeys = new Set(stored.map((item) => item.segmentKey));
    const fresh = unique.filter((s) => !storedKeys.has(segmentKeyOf(input.sttSessionId, s.utteranceIndex)));
    if (fresh.length === 0) {
      return { accepted: 0, duplicates: segments.length, lastSegmentSeq: consultation.segmentSeqHead };
    }

    const offsetMs = await this.recordingOffsetFor(consultation, input.sttSessionId);
    const ciphertexts = await this.encryptTexts(fresh.map((s) => s.text));
    const runKey = sttStreamRunKey(input.sttSessionId);

    const { inserted, last } = await this.inTransaction(async (tx) => {
      const range = await this.consultationRepository.allocateSegmentSeqs(consultation.id, fresh.length, tx);
      const entities = fresh.map((segment, i) => {
        const entity = ContextItemFactory.CreateTranscriptSegment({
          tenantId: consultation.tenantId,
          consultationId: consultation.id,
          encounterSeq: consultation.currentEncounterSeq,
          segmentSeq: range.first + i,
          segmentKey: segmentKeyOf(input.sttSessionId, segment.utteranceIndex),
          content: segment.text,
          t0Ms: offsetMs + Math.max(0, Math.round(segment.startMs)),
          t1Ms: offsetMs + Math.max(0, Math.round(segment.endMs)),
          speaker: segment.speaker ?? null,
          capturedAt: this.parseDate(segment.capturedAt),
          metaData: {
            sttRunKey: runKey,
            sttSessionId: input.sttSessionId,
            utteranceIndex: segment.utteranceIndex,
            ...(segment.language ? { language: segment.language } : {}),
          },
        });
        stampContentCounters(entity, segment.text);
        const ciphertext = ciphertexts?.[i];
        if (ciphertext) {
          entity.encryptedContent = Buffer.from(ciphertext, 'utf8');
          entity.contentKeyVersion = parseKeyVersionFromCiphertext(ciphertext);
        }
        return entity;
      });
      const batch = await this.contextItemRepository.createSegmentsBatch(entities, tx);
      const versions = batch.inserted.map((item) => {
        const version = ContextItemVersionFactory.CreateVersion({
          contextItemId: item.id,
          versionNumber: 1,
          tenantId: item.tenantId,
          content: item.content,
          changeReason: 'initial_creation',
          changedBy: 'system',
          changeSource: 'ai',
        });
        version.metaData = { sttRunKey: runKey };
        if (item.encryptedContent) {
          version.encryptedContent = item.encryptedContent;
          version.keyVersion = item.contentKeyVersion ?? null;
        }
        return version;
      });
      if (versions.length > 0) await this.contextItemVersionRepository.createMany(versions, true, tx);
      return { inserted: batch.inserted, last: range.last };
    });

    if (inserted.length > 0) {
      this.broadcastSysEvent(SysEventType.ResourceCreated, {
        resourceId: inserted[0].id,
        data: { consultationId: consultation.id, type: ContextItemType.TRANSCRIPT_SEGMENT, count: inserted.length, lastSegmentSeq: last },
      });
    }

    return { accepted: inserted.length, duplicates: segments.length - inserted.length, lastSegmentSeq: last };
  }

  // ===========================================================================
  // Full transcript
  // ===========================================================================

  async onSessionFinal(input: {
    tenantId: string;
    consultationId: string;
    sttSessionId: string;
    sessionDurationMs?: number;
  }): Promise<{ contextItemId: string; versionNumber: number; segmentCount: number }> {
    const consultation = await this.loadConsultation(input.consultationId, input.tenantId);
    const runKey = sttStreamRunKey(input.sttSessionId);

    const rebuilt = await this.rebuildFullTranscript(consultation, {
      changeSource: 'ai',
      changeReason: 'stt_session_final',
      changedBy: 'system',
      metaData: { sttRunKey: runKey },
    });

    if (rebuilt?.appended) {
      const timestamp = new Date().toISOString();
      this.eventEmitter.emit(ConsultationPipelineEvent.FullTranscriptRebuilt, {
        consultationId: consultation.id,
        tenantId: consultation.tenantId,
        timestamp,
        contextItemId: rebuilt.item.id,
        versionNumber: rebuilt.versionNumber,
        segmentCount: rebuilt.segmentCount,
      } satisfies FullTranscriptRebuiltPayload);
      this.eventEmitter.emit(ConsultationPipelineEvent.TranscriptionCreated, {
        consultationId: consultation.id,
        tenantId: consultation.tenantId,
        timestamp,
        contextItemId: rebuilt.item.id,
        wordCount: countTranscriptWords(rebuilt.content),
        transcriptionSource: 'streaming',
      } satisfies TranscriptionCreatedPayload);
    }

    await this.emitEncounterStoppedIfPending(consultation.id);
    await this.markSessionFinal(consultation.id, input.sttSessionId);

    return rebuilt
      ? { contextItemId: rebuilt.item.id, versionNumber: rebuilt.versionNumber, segmentCount: rebuilt.segmentCount }
      : { contextItemId: '', versionNumber: 0, segmentCount: 0 };
  }

  async awaitFinal(consultationId: string, sttSessionIds: string[], timeoutMs: number): Promise<'complete' | 'pending'> {
    if (sttSessionIds.length === 0) return 'complete';
    if (!this.redisCache) return 'pending';
    const deadline = Date.now() + Math.max(0, timeoutMs);
    for (;;) {
      const finals = await Promise.all(sttSessionIds.map((sid) => this.redisCache!.exists(sttFinalRedisKey(consultationId, sid))));
      if (finals.every(Boolean)) return 'complete';
      const remaining = deadline - Date.now();
      if (remaining <= 0) return 'pending';
      await new Promise((resolve) => setTimeout(resolve, Math.min(AWAIT_FINAL_POLL_MS, remaining)));
    }
  }

  async onSegmentEdited(segmentItemId: string, versionNumber: number, changedBy: string): Promise<void> {
    const segment = await this.contextItemRepository.findByIdOrNull(segmentItemId);
    if (!segment) throw new NotFoundException(`Context item ${segmentItemId} not found`);
    if (segment.type !== ContextItemType.TRANSCRIPT_SEGMENT) return;

    // Before the first session final there is no FULL_TRANSCRIPT to derive from; the
    // final rebuild reads the edited version anyway.
    if (!(await this.contextItemRepository.findFullTranscript(segment.consultationId))) return;

    const consultation = await this.loadConsultation(segment.consultationId, segment.tenantId);
    const rebuilt = await this.rebuildFullTranscript(consultation, {
      changeSource: 'segment_edit',
      changeReason: 'segment_edit',
      changedBy,
      metaData: { derivedFrom: { contextItemId: segmentItemId, versionNumber } },
    });
    if (rebuilt?.appended) {
      this.eventEmitter.emit(ConsultationPipelineEvent.FullTranscriptRebuilt, {
        consultationId: consultation.id,
        tenantId: consultation.tenantId,
        userId: changedBy,
        timestamp: new Date().toISOString(),
        contextItemId: rebuilt.item.id,
        versionNumber: rebuilt.versionNumber,
        segmentCount: rebuilt.segmentCount,
      } satisfies FullTranscriptRebuiltPayload);
    }
  }

  // ===========================================================================
  // Recording
  // ===========================================================================

  async appendRecordingPart(input: {
    consultationId: string;
    audioRecordingId: string;
    mediaId: string;
    durationMs: number;
    encounterSeq: number;
    sttSessionId: string;
  }): Promise<{ contextItemId: string; versionNumber: number; totalMs: number }> {
    const consultation = await this.loadConsultation(input.consultationId);
    const audio = await this.audioRecordingRepository.findByIdOrNull(input.audioRecordingId);
    if (!audio) throw new NotFoundException(`Audio recording ${input.audioRecordingId} not found`);

    let container = (await this.contextItemRepository.findAudioRecordings(consultation.id))[0] ?? null;
    const current = this.manifestOf(container);
    if (container && current.parts.some((part) => part.audioRecordingId === input.audioRecordingId)) {
      return { contextItemId: container.id, versionNumber: container.currentVersionNumber, totalMs: current.totalMs };
    }

    const durationMs = Math.max(0, Math.round(input.durationMs));
    const span = await this.consultationRepository.advanceRecordingCursor(consultation.id, durationMs);
    const codec = current.codec ?? audio.codec ?? audio.format ?? null;

    audio.encounterSeq = input.encounterSeq;
    audio.recordingStartMs = span.startMs;
    audio.sttSessionId = input.sttSessionId || null;
    if (!audio.codec && codec) audio.codec = codec;
    await this.audioRecordingRepository.update(audio.id, audio);

    const manifest: RecordingManifest = {
      codec,
      totalMs: current.totalMs + durationMs,
      parts: [
        ...current.parts,
        {
          audioRecordingId: input.audioRecordingId,
          mediaId: input.mediaId,
          encounterSeq: input.encounterSeq,
          sttSessionId: input.sttSessionId || null,
          startMs: span.startMs,
          durationMs,
        },
      ],
    };

    if (!container) {
      container = await this.contextItemRepository.create(ContextItemFactory.CreateAudioRecording(consultation.tenantId, consultation.id));
    }
    const versionNumber = await this.appendVersion(container, null, {
      changeSource: 'system',
      changeReason: 'recording_part',
      changedBy: 'system',
      metaData: { manifest },
    }, { ...(container.metaData ?? {}), manifest });

    return { contextItemId: container.id, versionNumber, totalMs: manifest.totalMs };
  }

  // ===========================================================================
  // Per-encounter artifacts
  // ===========================================================================

  async upsertEncounterArtifact(input: {
    consultationId: string;
    encounterSeq: number;
    type: 'FACT_LEDGER' | 'ENCOUNTER_RECAP';
    content: string;
    source: 'AI' | 'SYSTEM';
    changedBy: string;
    metaData: Record<string, unknown>;
  }): Promise<{ contextItemId: string; versionNumber: number }> {
    const consultation = await this.loadConsultation(input.consultationId);
    const type = input.type === 'FACT_LEDGER' ? ContextItemType.FACT_LEDGER : ContextItemType.ENCOUNTER_RECAP;
    const write: VersionWrite = {
      changeSource: input.source === 'AI' ? 'ai' : 'system',
      changeReason: input.type === 'FACT_LEDGER' ? 'fact_ledger' : 'encounter_recap',
      changedBy: input.changedBy,
      metaData: input.metaData,
    };

    const existing = await this.contextItemRepository.findEncounterArtifact(consultation.id, type, input.encounterSeq);
    if (existing) {
      const versionNumber = await this.appendVersion(existing, input.content, write, { ...(existing.metaData ?? {}), ...input.metaData });
      return { contextItemId: existing.id, versionNumber };
    }

    const item = ContextItemFactory.CreateContextItem({
      tenantId: consultation.tenantId,
      consultationId: consultation.id,
      type,
      source: input.source === 'AI' ? ContextItemSource.AI : ContextItemSource.SYSTEM,
      content: input.content,
      encounterSeq: input.encounterSeq,
      metaData: input.metaData,
      createdBy: input.changedBy,
    });
    try {
      const saved = await this.createWithFirstVersion(item, write);
      return { contextItemId: saved.id, versionNumber: 1 };
    } catch (error) {
      // A concurrent producer won the partial unique index — append to its item instead.
      const winner = await this.contextItemRepository.findEncounterArtifact(consultation.id, type, input.encounterSeq);
      if (!winner) throw error;
      const versionNumber = await this.appendVersion(winner, input.content, write, { ...(winner.metaData ?? {}), ...input.metaData });
      return { contextItemId: winner.id, versionNumber };
    }
  }

  // ===========================================================================
  // Internals
  // ===========================================================================

  private async loadConsultation(consultationId: string, tenantId?: string): Promise<ConsultationEntity> {
    const consultation = await this.consultationRepository.findByIdOrNull(consultationId);
    if (!consultation || (tenantId !== undefined && consultation.tenantId !== tenantId)) {
      throw new NotFoundException(`Consultation ${consultationId} not found`);
    }
    return consultation;
  }

  /**
   * Where this STT session sits on the consultation recording timeline. The session's
   * `TranscriptionJob.metaData.recordingOffsetMs` is authoritative; a session row without one
   * is bound here, once, to the recording cursor as it stands at the session's first final.
   */
  private async recordingOffsetFor(consultation: ConsultationEntity, sttSessionId: string): Promise<number> {
    const [job] = await this.transcriptionJobRepository.findAll({
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      filters: { streamSessionId: sttSessionId } as any,
      limit: 1,
      sort: [{ createdAt: 'desc' }],
    });
    const meta = (job?.metaData ?? {}) as Record<string, unknown>;
    if (typeof meta.recordingOffsetMs === 'number') return meta.recordingOffsetMs;

    const offset = consultation.recordingCursorMs ?? 0;
    if (job) {
      try {
        job.metaData = { ...meta, recordingOffsetMs: offset };
        await this.transcriptionJobRepository.update(job.id, job);
      } catch (error) {
        this.logger.warn({
          message: 'transcript_record.binding_offset_not_stamped',
          sttSessionId,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
    return offset;
  }

  /** One Transit round trip for the whole batch; `null` when encryption is skipped (dev/test). */
  private async encryptTexts(texts: string[]): Promise<string[] | null> {
    let ciphertexts: string[] | null = null;
    await encryptPhiFields(
      this.secretsService,
      'ContextItem segment content',
      async () => {
        const secrets = this.secretsService!;
        const key = secrets.getPhiTransitKeyName();
        const plaintexts = texts.map((text) => Buffer.from(text, 'utf8'));
        const out = await secrets.encryptBatch(plaintexts, key);
        if (out.length !== texts.length) throw new Error('Transit batch encrypt returned a mismatched result count');
        ciphertexts = out;
      },
      this.logger,
    );
    return ciphertexts;
  }

  private async rebuildFullTranscript(
    consultation: ConsultationEntity,
    write: VersionWrite,
  ): Promise<{ item: ContextItemEntity; versionNumber: number; segmentCount: number; content: string; appended: boolean } | null> {
    const segments = (await this.contextItemRepository.findSegments(consultation.id)).filter(
      (segment) => !(segment.metaData as Record<string, unknown> | undefined)?.origin,
    );
    if (segments.length === 0) return null;

    const texts = await this.segmentTexts(segments);
    const content = this.render(segments, texts);
    const segmentDigest = createHash('sha256')
      .update(segments.map((s) => `${s.id}:${s.currentVersionNumber}`).join('|'))
      .digest('hex');
    const itemMeta = { ...(write.metaData?.sttRunKey ? { sttRunKey: write.metaData.sttRunKey } : {}), segmentDigest, segmentCount: segments.length };

    const existing = await this.contextItemRepository.findFullTranscript(consultation.id);
    if (existing) {
      const existingMeta = (existing.metaData ?? {}) as Record<string, unknown>;
      if (existingMeta.segmentDigest === segmentDigest) {
        return { item: existing, versionNumber: existing.currentVersionNumber, segmentCount: segments.length, content, appended: false };
      }
      const versionNumber = await this.appendVersion(
        existing,
        content,
        { ...write, metaData: { ...write.metaData, segmentDigest, segmentCount: segments.length } },
        { ...existingMeta, ...itemMeta },
      );
      return { item: existing, versionNumber, segmentCount: segments.length, content, appended: true };
    }

    const item = ContextItemFactory.CreateContextItem({
      tenantId: consultation.tenantId,
      consultationId: consultation.id,
      type: ContextItemType.FULL_TRANSCRIPT,
      source: ContextItemSource.TRANSCRIPTION,
      content,
      metaData: itemMeta,
      createdBy: write.changedBy,
    });
    const saved = await this.createWithFirstVersion(item, { ...write, metaData: { ...write.metaData, segmentDigest, segmentCount: segments.length } });
    return { item: saved, versionNumber: 1, segmentCount: segments.length, content, appended: true };
  }

  /** Plaintext of each segment's current version (decrypt-on-read first, one batch decrypt for the rest). */
  private async segmentTexts(segments: ContextItemEntity[]): Promise<string[]> {
    const texts = segments.map((segment) => segment.content ?? null);
    const missing = segments
      .map((segment, i) => ({ i, ct: segment.encryptedContent }))
      .filter(({ i, ct }) => texts[i] === null && ct && ct.length > 0);
    if (missing.length > 0 && this.secretsService) {
      const plaintexts = await this.secretsService.decryptBatch(
        missing.map(({ ct }) => Buffer.from(ct as Uint8Array).toString('utf8')),
        this.secretsService.getPhiTransitKeyName(),
      );
      missing.forEach(({ i }, n) => (texts[i] = plaintexts[n].toString('utf8')));
    }
    return texts.map((text) => text ?? '');
  }

  /** One line per segment (`speaker: text`), a blank line between encounters. */
  private render(segments: ContextItemEntity[], texts: string[]): string {
    const lines: string[] = [];
    let encounter: number | null | undefined;
    segments.forEach((segment, i) => {
      const text = texts[i].trim();
      if (!text) return;
      if (encounter !== undefined && segment.encounterSeq !== encounter) lines.push('');
      encounter = segment.encounterSeq;
      lines.push(segment.speaker ? `${segment.speaker}: ${text}` : text);
    });
    return lines.join('\n');
  }

  private async createWithFirstVersion(item: ContextItemEntity, write: VersionWrite): Promise<ContextItemEntity> {
    await this.encryptItem(item);
    const version = this.buildVersion(item, 1, item.content ?? null, write);
    await this.encryptVersion(version);
    const saved = await this.inTransaction(async (tx) => {
      const created = await this.contextItemRepository.create(item, tx);
      await this.contextItemVersionRepository.create(version, tx);
      return created;
    });
    this.broadcastSysEvent(SysEventType.ResourceCreated, {
      resourceId: saved.id,
      data: { consultationId: saved.consultationId, type: saved.type, versionCreated: 1 },
    });
    return saved;
  }

  /** Append the next version and move the item to it. `content === null` keeps a media item body-less. */
  private async appendVersion(item: ContextItemEntity, content: string | null, write: VersionWrite, itemMetaData: Record<string, unknown>): Promise<number> {
    const latest = await this.contextItemVersionRepository.getLatestVersionNumber(item.id);
    const versionNumber = latest + 1;

    if (content !== null) {
      item.content = content;
      stampContentCounters(item, content);
      item.markQdrantNeedsSync();
      await this.encryptItem(item);
    }
    item.metaData = itemMetaData;
    item.currentVersionNumber = versionNumber;
    item.updatedBy = write.changedBy;

    const version = this.buildVersion(item, versionNumber, content, write);
    await this.encryptVersion(version);
    await this.inTransaction(async (tx) => {
      await this.contextItemVersionRepository.create(version, tx);
      await this.contextItemRepository.update(item.id, item, tx);
    });
    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: item.id,
      data: { consultationId: item.consultationId, type: item.type, versionCreated: versionNumber, changeSource: write.changeSource },
    });
    return versionNumber;
  }

  private buildVersion(item: ContextItemEntity, versionNumber: number, content: string | null, write: VersionWrite): ContextItemVersionEntity {
    const version = ContextItemVersionFactory.CreateVersion({
      contextItemId: item.id,
      versionNumber,
      tenantId: item.tenantId,
      content,
      changeReason: write.changeReason,
      changedBy: write.changedBy,
      changeSource: write.changeSource,
    });
    if (write.metaData) version.metaData = write.metaData;
    return version;
  }

  private async encryptItem(item: ContextItemEntity): Promise<void> {
    await encryptPhiFields(
      this.secretsService,
      'ContextItem content',
      () => this.contextItemRepository.encryptContentIntoEntity(item, this.secretsService!),
      this.logger,
    );
  }

  private async encryptVersion(version: ContextItemVersionEntity): Promise<void> {
    await encryptPhiFields(
      this.secretsService,
      'ContextItemVersion',
      () => this.contextItemVersionRepository.encryptFieldsIntoEntity(version, this.secretsService!),
      this.logger,
    );
  }

  private manifestOf(container: ContextItemEntity | null): RecordingManifest {
    const manifest = (container?.metaData as Record<string, unknown> | undefined)?.manifest as RecordingManifest | undefined;
    return {
      codec: manifest?.codec ?? null,
      totalMs: typeof manifest?.totalMs === 'number' ? manifest.totalMs : 0,
      parts: Array.isArray(manifest?.parts) ? manifest.parts : [],
    };
  }

  /**
   * A session final that lands after `stop()` returned `pending` completes that stop: the
   * consultation is STOPPED and nobody has announced the encounter yet. The Redis claim makes
   * this and the lifecycle's own emission mutually exclusive.
   */
  private async emitEncounterStoppedIfPending(consultationId: string): Promise<void> {
    const consultation = await this.consultationRepository.findByIdOrNull(consultationId);
    if (!consultation || consultation.status !== ConsultationStatus.STOPPED) return;
    const encounterSeq = consultation.currentEncounterSeq;
    if (!(await this.claim(encounterStoppedRedisKey(consultationId, encounterSeq)))) return;
    this.eventEmitter.emit(ConsultationPipelineEvent.EncounterStopped, {
      consultationId,
      tenantId: consultation.tenantId,
      timestamp: new Date().toISOString(),
      encounterSeq,
    } satisfies EncounterStoppedPayload);
  }

  private async claim(key: string): Promise<boolean> {
    if (!this.redisCache) return true;
    try {
      const result = await this.redisCache.eval(
        "return redis.call('SET', KEYS[1], ARGV[1], 'NX', 'EX', ARGV[2])",
        1,
        key,
        '1',
        TRANSCRIPT_RECORD_MARKER_TTL_SECONDS,
      );
      return result === 'OK';
    } catch (error) {
      this.logger.warn({ message: 'transcript_record.claim_failed', error: error instanceof Error ? error.message : String(error) });
      return true;
    }
  }

  private async markSessionFinal(consultationId: string, sttSessionId: string): Promise<void> {
    if (!this.redisCache) return;
    try {
      await this.redisCache.setex(sttFinalRedisKey(consultationId, sttSessionId), TRANSCRIPT_RECORD_MARKER_TTL_SECONDS, '1');
    } catch (error) {
      this.logger.warn({ message: 'transcript_record.final_marker_failed', error: error instanceof Error ? error.message : String(error) });
    }
  }

  private async inTransaction<T>(work: (tx: Tx | undefined) => Promise<T>): Promise<T> {
    if (!this.unitOfWorkService) return work(undefined);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return this.unitOfWorkService.runInTransaction(async (tx: any) => work(tx));
  }

  private parseDate(value: string | undefined): Date | null {
    if (!value) return null;
    const date = new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
}
