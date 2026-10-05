import { createHash } from 'node:crypto';
import { Readable } from 'node:stream';
import { vi } from 'vitest';
import { ConsultationAttachmentEntity } from '@arcaai/domains';

export const TENANT = 'tenant-1';
export const OTHER_TENANT = 'tenant-2';
export const CONSULTATION = '0191c3a0-0000-7000-8000-000000000001';
export const DOCTOR = 'doctor-1';

export const sha256Hex = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('hex');
export const sha256B64 = (bytes: Buffer): string => createHash('sha256').update(bytes).digest('base64');

export const PDF = Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(256, 0x20)]);
export const WAV = Buffer.concat([Buffer.from('RIFF'), Buffer.alloc(4), Buffer.from('WAVE'), Buffer.alloc(256, 1)]);
export const NOTE = Buffer.from('Patient reports a three-day cough. No fever.', 'utf8');

/** An in-memory `ConsultationAttachmentRepository` with the real conditional-update semantics. */
export class FakeAttachmentRepository {
  readonly rows = new Map<string, ConsultationAttachmentEntity>();
  readonly create = vi.fn(async (entity: ConsultationAttachmentEntity) => {
    if (
      entity.idempotencyKey &&
      [...this.rows.values()].some(
        (r) => r.tenantId === entity.tenantId && r.consultationId === entity.consultationId && r.idempotencyKey === entity.idempotencyKey,
      )
    ) {
      throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    }
    this.rows.set(entity.id, entity);
    return entity;
  });
  readonly findByIdOrNull = vi.fn(async (id: string) => this.rows.get(id) ?? null);
  readonly findByIdempotencyKey = vi.fn(
    async (tenantId: string, consultationId: string, key: string) =>
      [...this.rows.values()].find((r) => r.tenantId === tenantId && r.consultationId === consultationId && r.idempotencyKey === key) ?? null,
  );
  readonly findByTranscriptionJobId = vi.fn(async (jobId: string) => [...this.rows.values()].find((r) => r.transcriptionJobId === jobId) ?? null);
  readonly findByConsultation = vi.fn(async (consultationId: string) => [...this.rows.values()].filter((r) => r.consultationId === consultationId));
  readonly findReapable = vi.fn(async (now: Date) =>
    [...this.rows.values()].filter((r) => r.status === 'INTENT' && r.intentExpiresAt.getTime() < now.getTime()),
  );
  readonly compareAndSetStatus = vi.fn(async (id: string, from: string[], to: string, data: Record<string, unknown> = {}) => {
    const row = this.rows.get(id);
    if (!row || !from.includes(row.status)) return false;
    for (const [key, value] of Object.entries(data)) (row as unknown as Record<string, unknown>)[key] = value;
    (row as unknown as Record<string, unknown>).status = to;
    return true;
  });
  readonly claimIntentToUploaded = vi.fn(async (id: string) => this.compareAndSetStatus(id, ['INTENT'], 'UPLOADED'));
  readonly expireIntent = vi.fn(async (id: string) => this.compareAndSetStatus(id, ['INTENT'], 'EXPIRED'));
  readonly update = vi.fn(async (_id: string, entity: ConsultationAttachmentEntity) => entity);
  readonly encryptFileNameIntoEntity = vi.fn(async () => undefined);
}

/** An in-memory blob store with the facade's method shapes. */
export class FakeBlobStorage {
  readonly objects = new Map<string, { body: Buffer; contentType: string; checksumSha256?: string }>();
  readonly presignPutIntent = vi.fn(
    async (p: { bucket: string; key: string; contentType: string; contentLength: number; checksumSha256?: string; expiresSeconds: number }) => ({
      url: `https://store.example/${p.bucket}/${p.key}?sig=${this.presignPutIntent.mock.calls.length}`,
      headers: {
        'Content-Type': p.contentType,
        'Content-Length': String(p.contentLength),
        ...(p.checksumSha256 ? { 'x-amz-checksum-sha256': p.checksumSha256 } : {}),
      },
    }),
  );
  readonly assertCanStore = vi.fn(async (_bucket: string, _bytes: number) => undefined);
  readonly recordExternalWrite = vi.fn(async (_bucket: string, _bytes: number) => undefined);
  readonly headObject = vi.fn(async (bucket: string, key: string) => {
    const o = this.objects.get(`${bucket}/${key}`);
    return o ? { sizeBytes: o.body.length, contentType: o.contentType, etag: 'e', checksumSha256: o.checksumSha256 } : null;
  });
  readonly getObjectRange = vi.fn(async (bucket: string, key: string, start: number, end: number) =>
    (this.objects.get(`${bucket}/${key}`)?.body ?? Buffer.alloc(0)).subarray(start, end + 1),
  );
  readonly getObject = vi.fn(async (p: { bucket: string; key: string }) => this.objects.get(`${p.bucket}/${p.key}`)!.body);
  readonly getObjectStream = vi.fn(async (p: { bucket: string; key: string }) => Readable.from([this.objects.get(`${p.bucket}/${p.key}`)!.body]));
  readonly putObject = vi.fn(async (p: { bucket: string; key: string; body: Buffer; contentType: string }) => {
    this.objects.set(`${p.bucket}/${p.key}`, { body: p.body, contentType: p.contentType });
  });
  readonly deleteObject = vi.fn(async (p: { bucket: string; key: string }) => {
    this.objects.delete(`${p.bucket}/${p.key}`);
  });
  readonly resolveDescriptor = vi.fn(async () => null);

  /** What a client PUT through the presigned URL does. */
  clientPut(bucket: string, key: string, body: Buffer, opts: { contentType?: string; withChecksum?: boolean } = {}): void {
    this.objects.set(`${bucket}/${key}`, {
      body,
      contentType: opts.contentType ?? 'application/octet-stream',
      ...(opts.withChecksum ? { checksumSha256: sha256B64(body) } : {}),
    });
  }
}

export function makeCls(tenantId: string | null = TENANT, userId: string | null = DOCTOR) {
  const store = new Map<string, unknown>([
    ['tenantId', tenantId],
    ['user', userId ? { id: userId, tenantId } : undefined],
  ]);
  return {
    get: vi.fn((key: string) => store.get(key)),
    set: vi.fn((key: string, value: unknown) => store.set(key, value)),
    run: vi.fn(async (fn: () => unknown) => fn()),
    getId: vi.fn(() => 'req-1'),
    store,
  };
}

/** Settings with the descriptor defaults, overridable per key. */
export function makeSettings(overrides: Record<string, unknown> = {}) {
  const values: Record<string, unknown> = {
    'media.upload.maxAttachmentSizeMb': 25,
    'media.upload.maxAudioSizeMb': 250,
    'stt.batch.maxFileSizeMb': 250,
    'consultation.attachments.multipartMaxMb': 10,
    'consultation.attachments.uploadUrlTtlSeconds': 600,
    'consultation.attachments.intentTtlHours': 24,
    'consultation.attachments.reapCron': '*/15 * * * *',
    'consultation.attachments.inlineVerifyMaxMb': 32,
    ...overrides,
  };
  const read = (key: string) => ({ key, value: values[key], source: 'system' });
  return {
    values,
    resolve: vi.fn((key: string, _tenantId: string | null) => read(key)),
    resolvePlatform: vi.fn((key: string) => read(key)),
  };
}

export function makeGate() {
  return {
    assertContentWritable: vi.fn(async () => undefined),
    touchActivity: vi.fn(async () => undefined),
    beginProcessing: vi.fn(async () => undefined),
    endProcessing: vi.fn(async () => undefined),
    setProcessing: vi.fn(async () => undefined),
    currentEncounterSeq: vi.fn(async () => 1),
  };
}

export function makeConsultations(
  rows: Array<{ id: string; tenantId: string; doctorId?: string }> = [{ id: CONSULTATION, tenantId: TENANT, doctorId: DOCTOR }],
) {
  return {
    findById: vi.fn(async (id: string) => rows.find((r) => r.id === id) ?? null),
    findByIdOrNull: vi.fn(async (id: string) => rows.find((r) => r.id === id) ?? null),
  };
}

export function makeBuckets() {
  return {
    getBucketByPurpose: vi.fn(async (purpose: string) =>
      purpose === 'AUDIO' ? { name: 'tenant-1-recordings' } : purpose === 'ATTACHMENTS' ? { name: 'tenant-1-attachments' } : null,
    ),
    getBucketBySlug: vi.fn(async () => null),
  };
}

export function makeMedia() {
  let n = 0;
  return { create: vi.fn(async (request: Record<string, unknown>) => ({ id: `media-${++n}`, ...request })) };
}

export function makeContext() {
  let n = 0;
  return { addContext: vi.fn(async (_consultationId: string, request: Record<string, unknown>) => ({ id: `item-${++n}`, ...request })) };
}

/** The context-item rows the encounter stamp reads and writes. */
export function makeContextItems() {
  const rows = new Map<string, { id: string; encounterSeq?: number | null }>();
  return {
    rows,
    findByIdOrNull: vi.fn(async (id: string) => {
      if (!rows.has(id)) rows.set(id, { id, encounterSeq: null });
      return rows.get(id)!;
    }),
    update: vi.fn(async (id: string, entity: { encounterSeq?: number | null }) => {
      rows.set(id, { ...rows.get(id)!, encounterSeq: entity.encounterSeq });
      return entity;
    }),
  };
}
