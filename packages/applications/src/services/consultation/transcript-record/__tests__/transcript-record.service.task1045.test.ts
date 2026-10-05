/**
 * The consultation record built from speech: TRANSCRIPT_SEGMENT ingest, the derived
 * FULL_TRANSCRIPT, the single AUDIO_RECORDING manifest, per-encounter artifacts, and the
 * three call sites that feed it (STT finalize, STT batch + attachment sink, context
 * `appendVersion`).
 *
 * Repositories are in-memory doubles over REAL domain entities (factories from
 * `@arcaai/domains`), so field names and setters are the production ones.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { ConflictException } from '@nestjs/common';
import { OptimisticConcurrencyException } from '@arcaai/exceptions';
import {
  AiActivityKind,
  AiActivityRunStatus,
  AudioRecordingFactory,
  ConsultationStatus,
  ContextItemEntity,
  ContextItemFactory,
  ContextItemSource,
  ContextItemType,
  ContextItemVersionEntity,
} from '@arcaai/domains';
import { ConsultationPipelineEvent } from '../../events';
import { TranscriptRecordService, stopAwaitingFinalRedisKey } from '../transcript-record.service';
import { sttBatchRunKey, sttFinalRedisKey, sttStreamRunKey } from '../transcript-record.keys';
import { SttInternalService } from '../../../stt/internal/sttInternal.service';
import { ContextService } from '../../context/context.service';
import { SecretsService } from '../../../baseServices/_meta/secrets/SecretsService';
import type { ISecretsProvider } from '../../../baseServices/_meta/secrets/ISecretsProvider';

const TENANT = '01900000-0000-7000-8000-000000000001';
const CID = '01900000-0000-7000-8000-0000000000c1';
const SID = 'stt-session-1';

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

function transit() {
  const encode = (b: Buffer) => `vault:v2:${b.toString('base64')}`;
  const decode = (ct: string) => Buffer.from(ct.split(':')[2] ?? '', 'base64');
  return {
    encrypt: vi.fn(async (plaintext: Buffer) => encode(plaintext)),
    decrypt: vi.fn(async (ct: string) => decode(ct)),
    encryptBatch: vi.fn(async (plaintexts: Buffer[]) => plaintexts.map(encode)),
    decryptBatch: vi.fn(async (cts: string[]) => cts.map(decode)),
    getPhiTransitKeyName: () => 'hope-phi',
  };
}

function redisDouble() {
  const store = new Map<string, string>();
  return {
    store,
    get: vi.fn(async (k: string) => store.get(k) ?? null),
    setex: vi.fn(async (k: string, _ttl: number, v: string) => void store.set(k, v)),
    exists: vi.fn(async (k: string) => store.has(k)),
    del: vi.fn(async (k: string) => void store.delete(k)),
    eval: vi.fn(async (_script: string, _n: number, key: string, value: string) => {
      if (store.has(key)) return null;
      store.set(key, String(value));
      return 'OK';
    }),
  };
}

interface ConsultationRow {
  id: string;
  tenantId: string;
  status: ConsultationStatus;
  currentEncounterSeq: number;
  segmentSeqHead: number;
  recordingCursorMs: number;
  lastActivityAt: Date;
  processing?: string;
  processingPrior?: string | null;
  version?: number;
}

function world() {
  const items = new Map<string, ContextItemEntity>();
  const versions: ContextItemVersionEntity[] = [];
  const consultation: ConsultationRow = {
    id: CID,
    tenantId: TENANT,
    status: ConsultationStatus.RECORDING,
    currentEncounterSeq: 1,
    segmentSeqHead: 0,
    recordingCursorMs: 0,
    lastActivityAt: new Date(0),
  };
  const jobs: Array<{ id: string; streamSessionId: string; metaData: Record<string, unknown>; tenantId: string }> = [];
  const audio = new Map<string, ReturnType<typeof AudioRecordingFactory.CreateAudioRecording>>();

  const save = (e: ContextItemEntity) => {
    items.set(e.id, e);
    return e;
  };

  const contextItemRepository = {
    findByIdOrNull: vi.fn(async (id: string) => items.get(id) ?? null),
    findById: vi.fn(async (id: string) => {
      const e = items.get(id);
      if (!e) throw new Error('not found');
      return e;
    }),
    findAll: vi.fn(async ({ filters }: { filters: Record<string, any> }) =>
      [...items.values()].filter((e) => e.consultationId === filters.consultationId && filters.segmentKey?.in?.includes(e.segmentKey)),
    ),
    findSegments: vi.fn(async (cid: string) =>
      [...items.values()]
        .filter((e) => e.consultationId === cid && e.type === ContextItemType.TRANSCRIPT_SEGMENT)
        .sort((a, b) => (a.segmentSeq ?? 0) - (b.segmentSeq ?? 0)),
    ),
    findFullTranscript: vi.fn(
      async (cid: string) => [...items.values()].find((e) => e.consultationId === cid && e.type === ContextItemType.FULL_TRANSCRIPT) ?? null,
    ),
    findEncounterArtifact: vi.fn(
      async (cid: string, type: ContextItemType, seq: number) =>
        [...items.values()].find((e) => e.consultationId === cid && e.type === type && e.encounterSeq === seq) ?? null,
    ),
    findAudioRecordings: vi.fn(async (cid: string) =>
      [...items.values()].filter((e) => e.consultationId === cid && e.type === ContextItemType.AUDIO_RECORDING),
    ),
    findTranscripts: vi.fn(async (cid: string) =>
      [...items.values()].filter((e) => e.consultationId === cid && e.type === ContextItemType.TRANSCRIPT),
    ),
    createSegmentsBatch: vi.fn(async (entities: ContextItemEntity[]) => {
      const keys = new Set([...items.values()].map((e) => e.segmentKey).filter(Boolean));
      const inserted = entities.filter((e) => !keys.has(e.segmentKey)).map(save);
      return { inserted, duplicateKeys: entities.filter((e) => keys.has(e.segmentKey)).map((e) => e.segmentKey as string) };
    }),
    create: vi.fn(async (e: ContextItemEntity) => save(e)),
    update: vi.fn(async (_id: string, e: ContextItemEntity) => save(e)),
    updateWithVersion: vi.fn(async (_id: string, e: ContextItemEntity) => save(e)),
    encryptContentIntoEntity: vi.fn(async (e: ContextItemEntity, secrets: ReturnType<typeof transit>) => {
      if (!e.content) return;
      const ct = await secrets.encrypt(Buffer.from(e.content, 'utf8'));
      e.encryptedContent = Buffer.from(ct, 'utf8');
      e.contentKeyVersion = 2;
    }),
  };

  const contextItemVersionRepository = {
    create: vi.fn(async (v: ContextItemVersionEntity) => {
      versions.push(v);
      return v;
    }),
    createMany: vi.fn(async (vs: ContextItemVersionEntity[]) => {
      versions.push(...vs);
      return { count: vs.length };
    }),
    getLatestVersionNumber: vi.fn(async (id: string) =>
      versions.filter((v) => v.contextItemId === id).reduce((m, v) => Math.max(m, v.versionNumber), 0),
    ),
    encryptFieldsIntoEntity: vi.fn(async () => undefined),
  };

  const consultationRepository = {
    findByIdOrNull: vi.fn(async (id: string) => (id === CID ? { ...consultation } : null)),
    touchActivity: vi.fn(async () => {
      consultation.lastActivityAt = new Date();
      return true;
    }),
    allocateSegmentSeqs: vi.fn(async (_id: string, count: number) => {
      consultation.segmentSeqHead += count;
      return { first: consultation.segmentSeqHead - count + 1, last: consultation.segmentSeqHead };
    }),
    setProcessing: vi.fn(async (_id: string, processing: string, options: { prior?: string | null } = {}) => {
      consultation.processing = processing;
      if (options.prior !== undefined) consultation.processingPrior = options.prior;
      return true;
    }),
    advanceRecordingCursor: vi.fn(async (_id: string, delta: number) => {
      consultation.recordingCursorMs += delta;
      return { startMs: consultation.recordingCursorMs - delta, endMs: consultation.recordingCursorMs };
    }),
  };

  const transcriptionJobRepository = {
    findAll: vi.fn(async ({ filters }: { filters: Record<string, any> }) => jobs.filter((j) => j.streamSessionId === filters.streamSessionId)),
    update: vi.fn(async (_id: string, j: unknown) => j),
  };

  const audioRecordingRepository = {
    findByIdOrNull: vi.fn(async (id: string) => audio.get(id) ?? null),
    update: vi.fn(async (_id: string, a: any) => a),
  };

  const encounter = { id: 'enc-1', seq: 1, recordingStartMs: null as number | null, recordingEndMs: 0 as number | null };
  const encounterRepository = {
    findBySeq: vi.fn(async (_id: string, seq: number) => (seq === encounter.seq ? encounter : null)),
    update: vi.fn(async (_id: string, e: unknown) => e),
  };

  const emitter = { emit: vi.fn() };
  const cls = { get: vi.fn(() => undefined) };
  const secrets = transit();
  const redis = redisDouble();
  const uow = { runInTransaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn({ tx: true })) };

  const service = new TranscriptRecordService(
    contextItemRepository as any,
    contextItemVersionRepository as any,
    consultationRepository as any,
    transcriptionJobRepository as any,
    audioRecordingRepository as any,
    emitter as any,
    cls as any,
    secrets as any,
    redis as any,
    uow as any,
    encounterRepository as any,
  );

  return {
    service,
    encounter,
    encounterRepository,
    items,
    versions,
    consultation,
    jobs,
    audio,
    contextItemRepository,
    contextItemVersionRepository,
    consultationRepository,
    transcriptionJobRepository,
    audioRecordingRepository,
    emitter,
    cls,
    secrets,
    redis,
    uow,
  };
}

const seg = (utteranceIndex: number, text: string, startMs: number, speaker?: string) => ({
  utteranceIndex,
  text,
  startMs,
  endMs: startMs + 900,
  capturedAt: '2026-10-05T10:00:00.000Z',
  ...(speaker ? { speaker } : {}),
});

const emitted = (w: ReturnType<typeof world>) => w.emitter.emit.mock.calls.map((c) => c[0] as string);

// ---------------------------------------------------------------------------
// ingestSegments
// ---------------------------------------------------------------------------

describe('STT run keys', () => {
  it('are stt:<sttSessionId>:<runId|empty>:<seq>', () => {
    expect(sttStreamRunKey('abc123')).toBe('stt:abc123::0');
    expect(sttBatchRunKey('job-1')).toBe('stt::job-1:0');
  });
});

describe('TranscriptRecordService.ingestSegments', () => {
  let w: ReturnType<typeof world>;
  beforeEach(() => {
    w = world();
    w.jobs.push({ id: 'job-1', streamSessionId: SID, metaData: { recordingOffsetMs: 60_000 }, tenantId: TENANT });
  });

  it('writes one TRANSCRIPT_SEGMENT per final with the timeline offset, encounter and run key', async () => {
    w.consultation.currentEncounterSeq = 2;
    const result = await w.service.ingestSegments({
      tenantId: TENANT,
      consultationId: CID,
      sttSessionId: SID,
      audioOffsetMs: 5_000,
      segments: [seg(1, 'second', 2_000, 'doctor'), seg(0, 'first', 0, 'patient')],
    });

    expect(result).toEqual({ accepted: 2, duplicates: 0, lastSegmentSeq: 2 });
    const segments = await w.contextItemRepository.findSegments(CID);
    expect(segments.map((s) => [s.segmentSeq, s.segmentKey, s.t0Ms, s.t1Ms, s.speaker, s.encounterSeq])).toEqual([
      [1, `${SID}:0`, 60_000, 60_900, 'patient', 2],
      [2, `${SID}:1`, 62_000, 62_900, 'doctor', 2],
    ]);
    for (const s of segments) {
      expect(s.type).toBe(ContextItemType.TRANSCRIPT_SEGMENT);
      expect((s.metaData as Record<string, unknown>).sttRunKey).toBe(sttStreamRunKey(SID));
      expect(s.encryptedContent).toBeInstanceOf(Buffer);
    }
    // One immutable v1 version per inserted segment, carrying the same ciphertext.
    expect(w.versions.map((v) => [v.contextItemId, v.versionNumber])).toEqual(segments.map((s) => [s.id, 1]));
    expect(w.versions[0].encryptedContent).toEqual(segments[0].encryptedContent);
    expect(w.consultationRepository.touchActivity).toHaveBeenCalledWith(CID);
  });

  it('encrypts the whole batch in ONE Transit call', async () => {
    await w.service.ingestSegments({
      tenantId: TENANT,
      consultationId: CID,
      sttSessionId: SID,
      audioOffsetMs: 0,
      segments: [seg(0, 'a', 0), seg(1, 'b', 1000), seg(2, 'c', 2000)],
    });
    expect(w.secrets.encryptBatch).toHaveBeenCalledTimes(1);
    expect(w.secrets.encryptBatch.mock.calls[0][0]).toHaveLength(3);
    expect(w.secrets.encrypt).not.toHaveBeenCalled();
  });

  it('is idempotent on sttSessionId:utteranceIndex — a redelivery allocates no sequence numbers', async () => {
    const input = { tenantId: TENANT, consultationId: CID, sttSessionId: SID, audioOffsetMs: 0, segments: [seg(0, 'a', 0), seg(1, 'b', 1000)] };
    await w.service.ingestSegments(input);
    const again = await w.service.ingestSegments({ ...input, segments: [seg(1, 'b', 1000), seg(2, 'c', 2000), seg(2, 'c', 2000)] });

    expect(again).toEqual({ accepted: 1, duplicates: 2, lastSegmentSeq: 3 });
    expect(w.consultationRepository.allocateSegmentSeqs).toHaveBeenLastCalledWith(CID, 1, expect.anything());
    expect((await w.contextItemRepository.findSegments(CID)).map((s) => s.segmentKey)).toEqual([`${SID}:0`, `${SID}:1`, `${SID}:2`]);
  });

  it('treats an empty batch as a heartbeat (activity only)', async () => {
    w.consultation.segmentSeqHead = 7;
    const result = await w.service.ingestSegments({ tenantId: TENANT, consultationId: CID, sttSessionId: SID, audioOffsetMs: 0, segments: [] });
    expect(result).toEqual({ accepted: 0, duplicates: 0, lastSegmentSeq: 7 });
    expect(w.consultationRepository.touchActivity).toHaveBeenCalledWith(CID);
    expect(w.consultationRepository.allocateSegmentSeqs).not.toHaveBeenCalled();
    expect(w.secrets.encryptBatch).not.toHaveBeenCalled();
  });

  it('stamps the binding offset from the recording cursor when the session row has none', async () => {
    w.jobs.length = 0;
    w.jobs.push({ id: 'job-2', streamSessionId: SID, metaData: {}, tenantId: TENANT });
    w.consultation.recordingCursorMs = 30_000;
    await w.service.ingestSegments({ tenantId: TENANT, consultationId: CID, sttSessionId: SID, audioOffsetMs: 0, segments: [seg(0, 'a', 500)] });
    const [s] = await w.contextItemRepository.findSegments(CID);
    expect(s.t0Ms).toBe(30_500);
    expect(w.transcriptionJobRepository.update).toHaveBeenCalledWith('job-2', expect.objectContaining({ metaData: { recordingOffsetMs: 30_000 } }));
  });

  it('404s a consultation of another tenant', async () => {
    await expect(
      w.service.ingestSegments({ tenantId: 'other', consultationId: CID, sttSessionId: SID, audioOffsetMs: 0, segments: [seg(0, 'a', 0)] }),
    ).rejects.toMatchObject({ status: 404 });
  });
});

// ---------------------------------------------------------------------------
// FULL_TRANSCRIPT
// ---------------------------------------------------------------------------

describe('TranscriptRecordService full transcript', () => {
  let w: ReturnType<typeof world>;
  beforeEach(async () => {
    w = world();
    w.jobs.push({ id: 'job-1', streamSessionId: SID, metaData: { recordingOffsetMs: 0 }, tenantId: TENANT });
    await w.service.ingestSegments({
      tenantId: TENANT,
      consultationId: CID,
      sttSessionId: SID,
      audioOffsetMs: 0,
      segments: [seg(0, 'hello there', 0, 'doctor'), seg(1, 'my knee hurts', 1000, 'patient')],
    });
  });

  it('builds FULL_TRANSCRIPT on session final, then emits FullTranscriptRebuilt before TranscriptionCreated and marks the session final', async () => {
    const result = await w.service.onSessionFinal({ tenantId: TENANT, consultationId: CID, sttSessionId: SID });

    const full = await w.contextItemRepository.findFullTranscript(CID);
    expect(full).not.toBeNull();
    expect(result).toEqual({ contextItemId: full!.id, versionNumber: 1, segmentCount: 2 });
    expect(full!.content).toBe('doctor: hello there\npatient: my knee hurts');
    expect((full!.metaData as Record<string, unknown>).sttRunKey).toBe(sttStreamRunKey(SID));
    expect(w.versions.filter((v) => v.contextItemId === full!.id).map((v) => [v.versionNumber, v.changeSource])).toEqual([[1, 'ai']]);

    const order = emitted(w);
    const rebuilt = order.indexOf(ConsultationPipelineEvent.FullTranscriptRebuilt);
    const created = order.indexOf(ConsultationPipelineEvent.TranscriptionCreated);
    expect(rebuilt).toBeGreaterThanOrEqual(0);
    expect(created).toBeGreaterThan(rebuilt);
    const payload = w.emitter.emit.mock.calls[created][1];
    expect(payload).toMatchObject({ consultationId: CID, tenantId: TENANT, contextItemId: full!.id, transcriptionSource: 'streaming' });
    expect(order).not.toContain(ConsultationPipelineEvent.EncounterStopped);
    expect(w.redis.store.has(sttFinalRedisKey(CID, SID))).toBe(true);
  });

  it('appends a version across encounters and ignores items carrying metaData.origin', async () => {
    await w.service.onSessionFinal({ tenantId: TENANT, consultationId: CID, sttSessionId: SID });
    w.consultation.currentEncounterSeq = 2;
    await w.service.ingestSegments({
      tenantId: TENANT,
      consultationId: CID,
      sttSessionId: 'stt-2',
      audioOffsetMs: 0,
      segments: [seg(0, 'follow up', 0)],
    });
    const foreign = ContextItemFactory.CreateTranscriptSegment({
      tenantId: TENANT,
      consultationId: CID,
      encounterSeq: 2,
      segmentSeq: 99,
      segmentKey: 'x:0',
      content: 'from an upload',
      metaData: { origin: 'attachment_audio' },
    });
    w.items.set(foreign.id, foreign);

    const result = await w.service.onSessionFinal({ tenantId: TENANT, consultationId: CID, sttSessionId: 'stt-2' });
    const full = await w.contextItemRepository.findFullTranscript(CID);
    expect(result).toEqual({ contextItemId: full!.id, versionNumber: 2, segmentCount: 3 });
    expect(full!.content).toBe('doctor: hello there\npatient: my knee hurts\n\nfollow up');
    expect(full!.currentVersionNumber).toBe(2);
  });

  it('a repeated final with no new segments appends nothing and re-emits nothing', async () => {
    await w.service.onSessionFinal({ tenantId: TENANT, consultationId: CID, sttSessionId: SID });
    w.emitter.emit.mockClear();
    const again = await w.service.onSessionFinal({ tenantId: TENANT, consultationId: CID, sttSessionId: SID });
    expect(again.versionNumber).toBe(1);
    expect(emitted(w)).not.toContain(ConsultationPipelineEvent.TranscriptionCreated);
  });

  it('emits EncounterStopped once when the final completes a pending stop', async () => {
    w.consultation.status = ConsultationStatus.STOPPED;
    await w.service.onSessionFinal({ tenantId: TENANT, consultationId: CID, sttSessionId: SID });
    await w.service.onSessionFinal({ tenantId: TENANT, consultationId: CID, sttSessionId: SID });
    const stops = w.emitter.emit.mock.calls.filter((c) => c[0] === ConsultationPipelineEvent.EncounterStopped);
    expect(stops).toHaveLength(1);
    expect(stops[0][1]).toMatchObject({ consultationId: CID, tenantId: TENANT, encounterSeq: 1 });
    const order = emitted(w);
    expect(order.indexOf(ConsultationPipelineEvent.EncounterStopped)).toBeGreaterThan(order.indexOf(ConsultationPipelineEvent.TranscriptionCreated));
  });

  describe('a stop that returned `pending` (D-28) is completed by the late session final', () => {
    const lifecycleFrames = () =>
      w.emitter.emit.mock.calls
        .filter((c) => c[0] === ConsultationPipelineEvent.LifecycleChanged)
        .map((c) => c[1] as { event: Record<string, unknown> });

    beforeEach(() => {
      w.consultation.status = ConsultationStatus.STOPPED;
      w.consultation.processing = 'FINALIZING_TRANSCRIPT';
      w.consultation.processingPrior = null;
      w.consultation.version = 3;
    });

    it('restores processing (IDLE when nothing was replaced) and announces transcript_final — before TranscriptionCreated', async () => {
      await w.service.onSessionFinal({ tenantId: TENANT, consultationId: CID, sttSessionId: SID });

      expect(w.consultationRepository.setProcessing).toHaveBeenCalledWith(CID, 'IDLE', { prior: null });
      expect(w.consultation.processing).toBe('IDLE');
      const frames = lifecycleFrames();
      expect(frames).toHaveLength(1);
      expect(frames[0]).toMatchObject({
        consultationId: CID,
        tenantId: TENANT,
        event: { type: 'transcript_final', consultationId: CID, status: 'STOPPED', processing: 'IDLE', encounterSeq: 1, version: 3, seq: 0 },
      });
      const order = emitted(w);
      expect(order.indexOf(ConsultationPipelineEvent.LifecycleChanged)).toBeLessThan(order.indexOf(ConsultationPipelineEvent.TranscriptionCreated));
    });

    it('restores the processing value the stop replaced', async () => {
      w.consultation.processingPrior = 'AWAITING_REVIEW';
      await w.service.onSessionFinal({ tenantId: TENANT, consultationId: CID, sttSessionId: SID });
      expect(w.consultationRepository.setProcessing).toHaveBeenCalledWith(CID, 'AWAITING_REVIEW', { prior: null });
      expect(lifecycleFrames()[0]!.event).toMatchObject({ type: 'transcript_final', processing: 'AWAITING_REVIEW' });
    });

    it('a second final (or one after the note started) changes nothing: only FINALIZING_TRANSCRIPT is restored', async () => {
      await w.service.onSessionFinal({ tenantId: TENANT, consultationId: CID, sttSessionId: SID });
      w.consultation.processing = 'SUMMARIZING';
      await w.service.onSessionFinal({ tenantId: TENANT, consultationId: CID, sttSessionId: SID });
      expect(w.consultationRepository.setProcessing).toHaveBeenCalledTimes(1);
      expect(lifecycleFrames()).toHaveLength(1);
    });

    it('while the stop still waits in awaitFinal, the stop restores — the final does not', async () => {
      const waiting = w.service.awaitFinal(CID, [SID], 2_000);
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(w.redis.store.has(stopAwaitingFinalRedisKey(CID))).toBe(true);

      await w.service.onSessionFinal({ tenantId: TENANT, consultationId: CID, sttSessionId: SID });

      expect(await waiting).toBe('complete');
      expect(w.consultationRepository.setProcessing).not.toHaveBeenCalled();
      expect(lifecycleFrames()).toHaveLength(0);
      expect(w.redis.store.has(stopAwaitingFinalRedisKey(CID))).toBe(false);
    });

    it('once the stop gave up waiting (pending), the late final restores', async () => {
      expect(await w.service.awaitFinal(CID, [SID], 30)).toBe('pending');
      expect(w.redis.store.has(stopAwaitingFinalRedisKey(CID))).toBe(false);

      await w.service.onSessionFinal({ tenantId: TENANT, consultationId: CID, sttSessionId: SID });
      expect(w.consultation.processing).toBe('IDLE');
    });

    it('never on a consultation that is not STOPPED', async () => {
      w.consultation.status = ConsultationStatus.RECORDING;
      await w.service.onSessionFinal({ tenantId: TENANT, consultationId: CID, sttSessionId: SID });
      expect(w.consultationRepository.setProcessing).not.toHaveBeenCalled();
    });
  });

  it('returns no transcript (segmentCount 0) when the consultation has no segments', async () => {
    const empty = world();
    const result = await empty.service.onSessionFinal({ tenantId: TENANT, consultationId: CID, sttSessionId: SID });
    expect(result).toEqual({ contextItemId: '', versionNumber: 0, segmentCount: 0 });
    expect(emitted(empty)).not.toContain(ConsultationPipelineEvent.TranscriptionCreated);
    expect(empty.redis.store.has(sttFinalRedisKey(CID, SID))).toBe(true);
  });

  it('awaitFinal is complete once every session is final, pending on timeout', async () => {
    expect(await w.service.awaitFinal(CID, [SID], 50)).toBe('pending');
    await w.service.onSessionFinal({ tenantId: TENANT, consultationId: CID, sttSessionId: SID });
    expect(await w.service.awaitFinal(CID, [SID], 50)).toBe('complete');
    expect(await w.service.awaitFinal(CID, [SID, 'other'], 50)).toBe('pending');
    expect(await w.service.awaitFinal(CID, [], 50)).toBe('complete');
  });

  it('a segment edit appends a derived FULL_TRANSCRIPT version (segment_edit, derivedFrom)', async () => {
    await w.service.onSessionFinal({ tenantId: TENANT, consultationId: CID, sttSessionId: SID });
    const [first] = await w.contextItemRepository.findSegments(CID);
    first.content = 'hello, there';
    first.currentVersionNumber = 2;

    await w.service.onSegmentEdited(first.id, 2, 'doctor-1');

    const full = await w.contextItemRepository.findFullTranscript(CID);
    expect(full!.content).toBe('doctor: hello, there\npatient: my knee hurts');
    const v2 = w.versions.find((v) => v.contextItemId === full!.id && v.versionNumber === 2)!;
    expect(v2.changeSource).toBe('segment_edit');
    expect(v2.changedBy).toBe('doctor-1');
    expect(v2.metaData).toMatchObject({ derivedFrom: { contextItemId: first.id, versionNumber: 2 } });
  });
});

// ---------------------------------------------------------------------------
// Recording manifest + encounter artifacts
// ---------------------------------------------------------------------------

describe('TranscriptRecordService recording span from the captured audio (no recording part)', () => {
  const ingest = (w: ReturnType<typeof world>, sid: string, starts: number[]) =>
    w.service.ingestSegments({
      tenantId: TENANT,
      consultationId: CID,
      sttSessionId: sid,
      audioOffsetMs: 0,
      segments: starts.map((s, i) => seg(i, `utterance ${i}`, s)),
    });

  it('advances the cursor to the end of the session audio and closes the encounter window on session final', async () => {
    const w = world();
    w.jobs.push({ id: 'job-1', streamSessionId: SID, metaData: { recordingOffsetMs: 0 }, tenantId: TENANT });
    await ingest(w, SID, [0, 2_000, 40_000]);

    await w.service.onSessionFinal({ tenantId: TENANT, consultationId: CID, sttSessionId: SID });

    expect(w.consultation.recordingCursorMs).toBe(40_900);
    expect(w.encounter.recordingStartMs).toBe(0);
    expect(w.encounter.recordingEndMs).toBe(40_900);
  });

  it('is idempotent on a redelivered final', async () => {
    const w = world();
    w.jobs.push({ id: 'job-1', streamSessionId: SID, metaData: { recordingOffsetMs: 0 }, tenantId: TENANT });
    await ingest(w, SID, [0, 5_000]);

    await w.service.onSessionFinal({ tenantId: TENANT, consultationId: CID, sttSessionId: SID });
    await w.service.onSessionFinal({ tenantId: TENANT, consultationId: CID, sttSessionId: SID });

    expect(w.consultation.recordingCursorMs).toBe(5_900);
  });

  it('a recording part that lands after the fallback advance does not count the audio twice', async () => {
    const w = world();
    w.jobs.push({ id: 'job-1', streamSessionId: SID, metaData: { recordingOffsetMs: 0 }, tenantId: TENANT });
    await ingest(w, SID, [0, 5_000]);
    await w.service.onSessionFinal({ tenantId: TENANT, consultationId: CID, sttSessionId: SID });
    const part = AudioRecordingFactory.CreateAudioRecording({ tenantId: TENANT, contextItemId: 'c', mediaId: 'm-1', duration: 6_500, sequenceNumber: 1 } as any);
    w.audio.set(part.id, part);

    await w.service.appendRecordingPart({
      consultationId: CID,
      audioRecordingId: part.id,
      mediaId: 'm-1',
      durationMs: 6_500,
      encounterSeq: 1,
      sttSessionId: SID,
    });

    expect(w.consultation.recordingCursorMs).toBe(6_500);
    expect(part.recordingStartMs).toBe(0);
  });

  it('a second session continues after the first on the recording timeline', async () => {
    const w = world();
    w.jobs.push({ id: 'job-1', streamSessionId: SID, metaData: { recordingOffsetMs: 0 }, tenantId: TENANT });
    await ingest(w, SID, [0, 5_000]);
    await w.service.onSessionFinal({ tenantId: TENANT, consultationId: CID, sttSessionId: SID });
    w.jobs.push({ id: 'job-2', streamSessionId: 'stt-2', metaData: { recordingOffsetMs: w.consultation.recordingCursorMs }, tenantId: TENANT });
    await ingest(w, 'stt-2', [0, 3_000]);

    await w.service.onSessionFinal({ tenantId: TENANT, consultationId: CID, sttSessionId: 'stt-2' });

    expect(w.consultation.recordingCursorMs).toBe(5_900 + 3_900);
  });
});

describe('TranscriptRecordService recording + artifacts', () => {
  it('keeps ONE AUDIO_RECORDING item with a version per part and a {parts, totalMs} manifest', async () => {
    const w = world();
    const mk = (durationMs: number, codec: string) => {
      const a = AudioRecordingFactory.CreateAudioRecording({
        tenantId: TENANT,
        contextItemId: 'c',
        mediaId: `m-${durationMs}`,
        duration: durationMs,
        sequenceNumber: 1,
      } as any);
      a.codec = codec;
      w.audio.set(a.id, a);
      return a;
    };
    const p1 = mk(10_000, 'opus');
    const p2 = mk(4_000, 'opus');

    const r1 = await w.service.appendRecordingPart({
      consultationId: CID,
      audioRecordingId: p1.id,
      mediaId: 'm-1',
      durationMs: 10_000,
      encounterSeq: 1,
      sttSessionId: SID,
    });
    const r2 = await w.service.appendRecordingPart({
      consultationId: CID,
      audioRecordingId: p2.id,
      mediaId: 'm-2',
      durationMs: 4_000,
      encounterSeq: 2,
      sttSessionId: 'stt-2',
    });
    const replay = await w.service.appendRecordingPart({
      consultationId: CID,
      audioRecordingId: p2.id,
      mediaId: 'm-2',
      durationMs: 4_000,
      encounterSeq: 2,
      sttSessionId: 'stt-2',
    });

    const containers = await w.contextItemRepository.findAudioRecordings(CID);
    expect(containers).toHaveLength(1);
    expect(r1).toEqual({ contextItemId: containers[0].id, versionNumber: 1, totalMs: 10_000 });
    expect(r2).toEqual({ contextItemId: containers[0].id, versionNumber: 2, totalMs: 14_000 });
    expect(replay).toEqual(r2);
    const manifest = (containers[0].metaData as Record<string, any>).manifest;
    expect(manifest).toEqual({
      codec: 'opus',
      totalMs: 14_000,
      parts: [
        { audioRecordingId: p1.id, mediaId: 'm-1', encounterSeq: 1, sttSessionId: SID, startMs: 0, durationMs: 10_000 },
        { audioRecordingId: p2.id, mediaId: 'm-2', encounterSeq: 2, sttSessionId: 'stt-2', startMs: 10_000, durationMs: 4_000 },
      ],
    });
    expect(p2.recordingStartMs).toBe(10_000);
    expect(p2.encounterSeq).toBe(2);
    expect(w.versions.filter((v) => v.contextItemId === containers[0].id)).toHaveLength(2);
  });

  it('upserts one artifact per (type, encounter): create then append', async () => {
    const w = world();
    const a = await w.service.upsertEncounterArtifact({
      consultationId: CID,
      encounterSeq: 1,
      type: 'FACT_LEDGER',
      content: '{"facts":[]}',
      source: 'AI',
      changedBy: 'system',
      metaData: { schema: 'v1' },
    });
    const b = await w.service.upsertEncounterArtifact({
      consultationId: CID,
      encounterSeq: 1,
      type: 'FACT_LEDGER',
      content: '{"facts":[1]}',
      source: 'AI',
      changedBy: 'system',
      metaData: { schema: 'v1', factCount: 1 },
    });
    const c = await w.service.upsertEncounterArtifact({
      consultationId: CID,
      encounterSeq: 2,
      type: 'FACT_LEDGER',
      content: '{"facts":[]}',
      source: 'AI',
      changedBy: 'system',
      metaData: {},
    });

    expect(a.versionNumber).toBe(1);
    expect(b).toEqual({ contextItemId: a.contextItemId, versionNumber: 2 });
    expect(c.contextItemId).not.toBe(a.contextItemId);
    const item = w.items.get(a.contextItemId)!;
    expect(item.type).toBe(ContextItemType.FACT_LEDGER);
    expect(item.source).toBe(ContextItemSource.AI);
    expect(item.content).toBe('{"facts":[1]}');
    expect(item.metaData).toMatchObject({ factCount: 1 });
  });
});

// ---------------------------------------------------------------------------
// SttInternalService call sites
// ---------------------------------------------------------------------------

function sttInternal(overrides: { record?: any; sink?: any; runs?: any; job?: any; consultations?: any } = {}) {
  const items: ContextItemEntity[] = [];
  const job = overrides.job ?? null;
  const jobRepository = {
    findById: vi.fn(async () => job),
    findByIdOrNull: vi.fn(async () => job),
    findAll: vi.fn(async () => (job ? [job] : [])),
    update: vi.fn(async (_id: string, j: any) => j),
    updateWithVersion: vi.fn(async (_id: string, j: any) => j),
    encryptFieldsIntoEntity: vi.fn(async () => undefined),
  };
  const contextItemRepository = {
    findTranscripts: vi.fn(async () => items.filter((i) => i.type === ContextItemType.TRANSCRIPT)),
    create: vi.fn(async (e: ContextItemEntity) => {
      items.push(e);
      return e;
    }),
    update: vi.fn(async (_id: string, e: ContextItemEntity) => e),
    encryptContentIntoEntity: vi.fn(async () => undefined),
  };
  const emitter = { emit: vi.fn() };
  const service = new SttInternalService(
    jobRepository as any,
    contextItemRepository as any,
    {} as any,
    {} as any,
    emitter as any,
    { get: vi.fn() } as any,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    overrides.record,
    overrides.sink,
    overrides.runs,
    overrides.consultations,
  );
  return { service, items, emitter, jobRepository, contextItemRepository };
}

describe('SttInternalService routing', () => {
  it('streaming finalize keeps the aggregate row but leaves TranscriptionCreated to onSessionFinal', async () => {
    const record = { onSessionFinal: vi.fn(async () => ({ contextItemId: 'full-1', versionNumber: 1, segmentCount: 2 })) };
    const runs = { record: vi.fn(async () => undefined) };
    const s = sttInternal({ record, runs });

    await s.service.createTranscript({ transcriptText: 'hello', consultationId: CID, tenantId: TENANT, metadata: { sessionId: SID } } as any);

    expect(s.items).toHaveLength(1);
    expect(record.onSessionFinal).toHaveBeenCalledWith(expect.objectContaining({ tenantId: TENANT, consultationId: CID, sttSessionId: SID }));
    expect(s.emitter.emit.mock.calls.map((c) => c[0])).not.toContain(ConsultationPipelineEvent.TranscriptionCreated);
    expect(runs.record).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: TENANT,
        consultationId: CID,
        runKey: sttStreamRunKey(SID),
        activityKind: AiActivityKind.TRANSCRIBE_STREAM,
        status: AiActivityRunStatus.OK,
        contextItemId: 'full-1',
        outputVersionNumber: 1,
      }),
    );
  });

  it('streaming run record carries the ASR agent, model and encounter even before the job reports servedBy', async () => {
    const record = { onSessionFinal: vi.fn(async () => ({ contextItemId: 'full-1', versionNumber: 1, segmentCount: 2 })) };
    const runs = { record: vi.fn(async () => undefined) };
    const spec = {
      agent: { slug: 'realtime-transcription', versionId: 'v-1', versionNumber: 2 },
      models: { asr: { slug: 'whisper-ml-en', provider: 'built-in', format: 'WHISPER_CPP' } },
    };
    const job = { id: 'job-s', streamSessionId: SID, startedAt: new Date('2026-10-05T10:00:00Z'), servedBy: null, resolvedSpec: spec };
    const consultations = { findByIdOrNull: vi.fn(async () => ({ currentEncounterSeq: 2 })) };
    const s = sttInternal({ record, runs, job, consultations });

    await s.service.createTranscript({ transcriptText: 'hello', consultationId: CID, tenantId: TENANT, metadata: { sessionId: SID } } as any);

    expect(runs.record).toHaveBeenCalledWith(
      expect.objectContaining({
        activityKind: AiActivityKind.TRANSCRIBE_STREAM,
        agentSlug: 'realtime-transcription',
        model: 'whisper-ml-en',
        provider: 'built-in',
        encounterSeq: 2,
      }),
    );
  });

  it('streaming finalize with no segments falls back to TranscriptionCreated on the aggregate row', async () => {
    const record = { onSessionFinal: vi.fn(async () => ({ contextItemId: '', versionNumber: 0, segmentCount: 0 })) };
    const s = sttInternal({ record });
    await s.service.createTranscript({ transcriptText: 'hello', consultationId: CID, tenantId: TENANT, metadata: { sessionId: SID } } as any);
    const created = s.emitter.emit.mock.calls.find((c) => c[0] === ConsultationPipelineEvent.TranscriptionCreated);
    expect(created?.[1]).toMatchObject({ contextItemId: s.items[0].id });
  });

  it('batch path: the attachment sink claims the transcript — no TRANSCRIPT row, no TranscriptionCreated', async () => {
    const job = { id: 'job-9', tenantId: TENANT, consultationId: CID, contextItemId: 'att-item', setContextItem: vi.fn() };
    const sink = { onBatchTranscript: vi.fn(async () => true) };
    const s = sttInternal({ sink, job });

    const result = await s.service.createTranscript({ jobId: 'job-9', transcriptText: 'uploaded audio' } as any);

    expect(sink.onBatchTranscript).toHaveBeenCalledWith({ jobId: 'job-9', text: 'uploaded audio' });
    expect(result).toEqual({ contextItemId: 'att-item' });
    expect(s.items).toHaveLength(0);
    expect(s.emitter.emit.mock.calls.map((c) => c[0])).not.toContain(ConsultationPipelineEvent.TranscriptionCreated);
  });

  it('batch path: an unclaimed transcript is written as before and stamped with its run key', async () => {
    const job = { id: 'job-9', tenantId: TENANT, consultationId: CID, setContextItem: vi.fn() };
    const sink = { onBatchTranscript: vi.fn(async () => false) };
    const s = sttInternal({ sink, job });
    await s.service.createTranscript({ jobId: 'job-9', transcriptText: 'dictation' } as any);
    expect(s.items).toHaveLength(1);
    expect((s.items[0].metaData as Record<string, unknown>).sttRunKey).toBe(sttBatchRunKey('job-9'));
    expect(s.emitter.emit.mock.calls.map((c) => c[0])).toContain(ConsultationPipelineEvent.TranscriptionCreated);
  });

  it('batch completion records a TRANSCRIBE_BATCH run', async () => {
    const job = {
      id: 'job-9',
      tenantId: TENANT,
      consultationId: CID,
      contextItemId: 'tr-1',
      version: 3,
      startedAt: new Date('2026-10-05T10:00:00Z'),
      complete: vi.fn(function (this: any) {
        this.completedAt = new Date('2026-10-05T10:00:30Z');
      }),
      resolvedSpec: null,
    };
    const runs = { record: vi.fn(async () => undefined) };
    const s = sttInternal({ runs, job });
    await s.service.completeJob('job-9', { resultText: 'x', engine: 'whisper_cpp', durationSeconds: 12 } as any);
    expect(runs.record).toHaveBeenCalledWith(
      expect.objectContaining({
        runKey: sttBatchRunKey('job-9'),
        activityKind: AiActivityKind.TRANSCRIBE_BATCH,
        status: AiActivityRunStatus.OK,
        consultationId: CID,
        provider: 'whisper_cpp',
        contextItemId: 'tr-1',
        durationMs: 30_000,
      }),
    );
  });
});

// ---------------------------------------------------------------------------
// ContextService.appendVersion
// ---------------------------------------------------------------------------

function contextService(item: ContextItemEntity, extras: { gate?: any; record?: any; ambientTx?: unknown; uow?: any } = {}) {
  const versions: ContextItemVersionEntity[] = [];
  const contextItemRepository = {
    findById: vi.fn(async () => item),
    findByIdOrNull: vi.fn(async () => item),
    updateWithVersion: vi.fn(async (_id: string, e: ContextItemEntity) => e),
    encryptContentIntoEntity: vi.fn(async () => undefined),
  };
  const versionRepository = {
    getLatestVersionNumber: vi.fn(async () => item.currentVersionNumber),
    create: vi.fn(async (v: ContextItemVersionEntity) => {
      versions.push(v);
      return v;
    }),
    encryptFieldsIntoEntity: vi.fn(async () => undefined),
  };
  const cls = {
    get: vi.fn((k: string) =>
      k === 'tenantId' ? TENANT : k === 'user' ? { id: 'doctor-1' } : k === 'coreTransactionClient' ? extras.ambientTx : undefined,
    ),
  };
  const service = new ContextService(
    contextItemRepository as any,
    versionRepository as any,
    {} as any,
    {} as any,
    {} as any,
    {} as any,
    { emit: vi.fn() } as any,
    cls as any,
    undefined,
    undefined,
    undefined,
    undefined,
    extras.uow,
    undefined,
    extras.gate,
    extras.record,
  );
  return { service, versions, contextItemRepository, versionRepository };
}

describe('ContextService.appendVersion', () => {
  const makeItem = (type = ContextItemType.MODIFIED_SUMMARY) => {
    const e = ContextItemFactory.CreateContextItem({ tenantId: TENANT, consultationId: CID, type, content: 'old', currentVersionNumber: 3 });
    return e;
  };

  it('appends the next version and moves the item to it', async () => {
    const item = makeItem();
    const c = contextService(item);
    const result = await c.service.appendVersion({
      contextItemId: item.id,
      content: 'new',
      expectedVersion: 3,
      changeSource: 'feedback',
      changeReason: 'correction',
      changedBy: 'doctor-1',
      metaData: { feedbackId: 'fb-1' },
    });
    expect(result).toEqual({ versionNumber: 4 });
    expect(item.content).toBe('new');
    expect(item.currentVersionNumber).toBe(4);
    expect(c.versions[0]).toMatchObject({ versionNumber: 4, changeSource: 'feedback', changeReason: 'correction', changedBy: 'doctor-1' });
    expect(c.versions[0].metaData).toEqual({ feedbackId: 'fb-1' });
  });

  it('412s on a stale expectedVersion', async () => {
    const c = contextService(makeItem());
    await expect(
      c.service.appendVersion({ contextItemId: 'x', content: 'new', expectedVersion: 2, changeSource: 'manual', changedBy: 'doctor-1' }),
    ).rejects.toBeInstanceOf(OptimisticConcurrencyException);
    expect(c.versions).toHaveLength(0);
  });

  it('409s when the lifecycle gate locks content', async () => {
    const gate = {
      assertContentWritable: vi.fn(async () => {
        throw new ConflictException('CONSULTATION_APPROVED');
      }),
    };
    const c = contextService(makeItem(), { gate });
    await expect(
      c.service.appendVersion({ contextItemId: 'x', content: 'new', changeSource: 'manual', changedBy: 'doctor-1' }),
    ).rejects.toBeInstanceOf(ConflictException);
    expect(gate.assertContentWritable).toHaveBeenCalledWith(CID);
    expect(c.versions).toHaveLength(0);
  });

  it('writes through the ambient transaction of a caller already inside runInTransaction (no nesting)', async () => {
    const ambientTx = { ambient: true };
    const uow = { runInTransaction: vi.fn() };
    const item = makeItem();
    const c = contextService(item, { ambientTx, uow });
    await c.service.appendVersion({ contextItemId: item.id, content: 'new', changeSource: 'feedback', changedBy: 'doctor-1' });
    expect(uow.runInTransaction).not.toHaveBeenCalled();
    expect(c.versionRepository.create).toHaveBeenCalledWith(expect.anything(), ambientTx);
    expect(c.contextItemRepository.updateWithVersion).toHaveBeenCalledWith(item.id, item, expect.any(Number), ambientTx);
  });

  it('opens its own transaction when no caller transaction is in flight', async () => {
    const ownTx = { own: true };
    const uow = { runInTransaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => fn(ownTx)) };
    const item = makeItem();
    const c = contextService(item, { uow });
    await c.service.appendVersion({ contextItemId: item.id, content: 'new', changeSource: 'manual', changedBy: 'doctor-1' });
    expect(uow.runInTransaction).toHaveBeenCalledTimes(1);
    expect(c.versionRepository.create).toHaveBeenCalledWith(expect.anything(), ownTx);
  });

  it('a segment edit asks the transcript record for the derived full-transcript version', async () => {
    const record = { onSegmentEdited: vi.fn(async () => undefined) };
    const item = makeItem(ContextItemType.TRANSCRIPT_SEGMENT);
    const c = contextService(item, { record });
    await c.service.appendVersion({ contextItemId: item.id, content: 'fixed', changeSource: 'segment_edit', changedBy: 'doctor-1' });
    expect(record.onSegmentEdited).toHaveBeenCalledWith(item.id, 4, 'doctor-1');
  });
});

// ---------------------------------------------------------------------------
// SecretsService.encryptBatch
// ---------------------------------------------------------------------------

describe('SecretsService.encryptBatch', () => {
  it('delegates to the provider batch in one call', async () => {
    const provider = {
      name: 'vault',
      encryptBatch: vi.fn(async (pts: Buffer[]) => pts.map((p) => `vault:v1:${p.toString('base64')}`)),
    } as unknown as ISecretsProvider;
    const svc = new SecretsService(provider);
    const out = await svc.encryptBatch([Buffer.from('a'), Buffer.from('b')], 'hope-phi');
    expect(out).toHaveLength(2);
    expect((provider as any).encryptBatch).toHaveBeenCalledTimes(1);
  });

  it('fails fast without a Transit-capable provider', async () => {
    const svc = new SecretsService({ name: 'env' } as unknown as ISecretsProvider);
    await expect(svc.encryptBatch([Buffer.from('a')])).rejects.toThrow(/requires Vault provider/);
  });
});
