/**
 * In-memory fakes for the export / verify-upload / sweeper tests: the checkpoint repository, the
 * checkpoint store, the snapshot database session, the blob-storage factory, settings, CLS and
 * Redis. The archive sealing fake comes from the archive lane's helpers.
 */
import { PassThrough, Readable } from 'node:stream';
import { NotFoundException } from '@nestjs/common';
import { DataNotFoundException, OptimisticConcurrencyException } from '@arcaai/exceptions';
import { TenantCheckpointEntity, TenantCheckpointFactory, type CreateTenantCheckpointProps } from '@arcaai/domains';

import type { ICheckpointStore, SqlQuery } from '../../contracts';
import type { CheckpointDbConnector, CheckpointDbSession } from '../db-connector';

const FIELDS = [
  'tenantId', 'label', 'kind', 'origin', 'status', 'includesMedia', 'passphraseProtected', 'keyEnvelope', 'objectKey', 'uploadId',
  'sizeBytes', 'manifestDigest', 'manifestSummary', 'schemaFingerprint', 'sourceDeploymentId', 'formatVersion', 'progress',
  'heartbeatAt', 'cancelRequestedAt', 'startedAt', 'finishedAt', 'expiresAt', 'failureReason', 'failureDetail', 'resourceStatus',
  'createdAt', 'updatedAt', 'metaData',
] as const;

type Row = Record<string, any> & { id: string; version: number };

function matches(row: Row, where: Record<string, any> = {}): boolean {
  return Object.entries(where).every(([k, cond]) => {
    const v = row[k];
    if (cond && typeof cond === 'object' && !(cond instanceof Date) && !Array.isArray(cond)) {
      if ('not' in cond && v === cond.not) return false;
      if ('in' in cond && !cond.in.includes(v)) return false;
      if ('lt' in cond && !(v != null && v < cond.lt)) return false;
      return true;
    }
    return v === cond;
  });
}

export class FakeCheckpointRepo {
  rows = new Map<string, Row>();
  writes: { id: string; status: string }[] = [];
  softDeleted: string[] = [];
  /** Hook run on every findById (tests use it to flip cancelRequestedAt mid-export). */
  onFind?: (row: Row) => void;

  add(props: Partial<CreateTenantCheckpointProps> & { tenantId: string; id?: string; version?: number; updatedAt?: Date }): Row {
    const e = TenantCheckpointFactory.CreateTenantCheckpoint({ label: 'nightly', ...props } as CreateTenantCheckpointProps);
    const row: Row = { id: props.id ?? e.id, version: props.version ?? 1, resourceStatus: 'ENABLED' };
    for (const f of FIELDS) if ((e as any)[f] !== undefined) row[f] = (e as any)[f];
    for (const [k, v] of Object.entries(props)) if (v !== undefined) row[k] = v;
    this.rows.set(row.id, row);
    return row;
  }

  get(id: string): Row {
    return this.rows.get(id)!;
  }

  private toEntity(row: Row): TenantCheckpointEntity {
    return new TenantCheckpointEntity({ ...row } as any);
  }

  async findById(id: string): Promise<TenantCheckpointEntity> {
    const row = this.rows.get(id);
    if (!row) throw new DataNotFoundException('TenantCheckpoint', id);
    this.onFind?.(row);
    return this.toEntity(row);
  }

  async updateWithVersion(id: string, entity: TenantCheckpointEntity, expectedVersion: number): Promise<TenantCheckpointEntity> {
    const row = this.rows.get(id);
    if (!row) throw new DataNotFoundException('TenantCheckpoint', id);
    if (row.version !== expectedVersion) {
      throw new OptimisticConcurrencyException('TenantCheckpoint', id, { expectedVersion, currentVersion: row.version });
    }
    for (const f of FIELDS) row[f] = (entity as any)[f];
    row.version += 1;
    row.updatedAt = new Date();
    this.writes.push({ id, status: row.status });
    return this.toEntity(row);
  }

  async findAll(props: { where?: Record<string, any> }): Promise<TenantCheckpointEntity[]> {
    return [...this.rows.values()].filter((r) => matches(r, props.where)).map((r) => this.toEntity(r));
  }

  async findStale(before: Date): Promise<TenantCheckpointEntity[]> {
    return [...this.rows.values()]
      .filter((r) => r.status === 'RUNNING' && r.heartbeatAt && r.heartbeatAt < before && r.resourceStatus !== 'DELETED')
      .map((r) => this.toEntity(r));
  }

  async findIdleUploads(updatedBefore: Date): Promise<TenantCheckpointEntity[]> {
    return [...this.rows.values()]
      .filter((r) => r.status === 'UPLOADING' && r.updatedAt && r.updatedAt < updatedBefore && r.resourceStatus !== 'DELETED')
      .map((r) => this.toEntity(r));
  }

  async findReadyAnyTenant(): Promise<TenantCheckpointEntity[]> {
    return [...this.rows.values()].filter((r) => r.status === 'READY' && r.resourceStatus !== 'DELETED').map((r) => this.toEntity(r));
  }

  async softDelete(id: string): Promise<TenantCheckpointEntity> {
    const row = this.rows.get(id)!;
    row.resourceStatus = 'DELETED';
    row.version += 1;
    this.softDeleted.push(id);
    return this.toEntity(row);
  }
}

export class FakeStore implements ICheckpointStore {
  objects = new Map<string, Buffer>();
  aborted: string[] = [];
  abortedUploads: { key: string; uploadId: string }[] = [];
  deleted: string[] = [];

  async ensureBucket() {}
  objectKey(tenantId: string, checkpointId: string) {
    return `${tenantId}/${checkpointId}.hcp`;
  }
  openWriteStream(key: string) {
    const stream = new PassThrough();
    const parts: Buffer[] = [];
    stream.on('data', (c: Buffer) => parts.push(c));
    const done = new Promise<{ sizeBytes: number }>((resolve, reject) => {
      stream.on('end', () => {
        const buf = Buffer.concat(parts);
        this.objects.set(key, buf);
        resolve({ sizeBytes: buf.length });
      });
      stream.on('error', reject);
    });
    done.catch(() => undefined);
    return {
      stream,
      done,
      abort: async () => {
        this.aborted.push(key);
        if (!stream.destroyed) stream.destroy();
      },
    };
  }
  async openReadStream(key: string) {
    const b = this.objects.get(key);
    if (!b) throw new NotFoundException('missing');
    return Readable.from([b]);
  }
  async presignDownload() {
    return 'https://example.invalid/x';
  }
  async createUpload() {
    return { uploadId: 'u1' };
  }
  async presignUploadParts() {
    return [];
  }
  async completeUpload() {
    return { sizeBytes: 0 };
  }
  async abortUpload(key: string, uploadId: string) {
    this.abortedUploads.push({ key, uploadId });
  }
  async delete(key: string) {
    this.deleted.push(key);
    this.objects.delete(key);
  }
}

export interface FakeDbOptions {
  tenantRow?: Record<string, unknown> | null;
  /** model → raw CSV COPY output (header included). Models not listed emit `id\n`. */
  csv?: Record<string, string>;
  /** physical table → columns (default `['id']`). */
  columns?: Record<string, string[]>;
  media?: { id: string; bucketId: string | null; uri: string }[];
  refs?: unknown[];
  transit?: Record<string, number | null>;
  /** Throw when COPYing this model. */
  failOnCopy?: { model: string; error: Error };
}

export class FakeDb implements CheckpointDbConnector {
  statements: string[] = [];
  copies: string[] = [];
  released = 0;
  constructor(private readonly opts: FakeDbOptions = {}) {}

  async connect(): Promise<CheckpointDbSession> {
    const o = this.opts;
    const query: SqlQuery = async <T,>(sql: string, params: readonly unknown[] = []) => {
      this.statements.push(sql);
      let rows: unknown[] = [];
      if (/to_regclass\('_prisma_migrations'\)/.test(sql)) rows = [{ ledger: null }];
      else if (/information_schema\.columns/.test(sql)) {
        const tables = (params[0] as string[] | undefined) ?? ['Tenant', 'Agent'];
        rows = tables.flatMap((t) => (o.columns?.[t] ?? ['id']).map((c) => ({ table_name: t, column_name: c, is_nullable: 'YES', column_default: null, is_identity: 'NO' })));
      } else if (/row_to_json/.test(sql)) rows = o.tenantRow === null ? [] : [{ t: o.tenantRow ?? { id: params[0], key: 'acme', name: 'Acme' } }];
      else if (/FROM core\."Media"/.test(sql) && !/vault:v/.test(sql)) rows = o.media ?? [];
      else if (/"resultRef"|"payloadRef"/.test(sql)) rows = (o.refs ?? []).map((ref) => ({ ref }));
      else if (/vault:v/.test(sql)) rows = [o.transit ?? {}];
      return rows as T[];
    };
    return {
      query,
      copyOut: (sql: string) => {
        this.copies.push(sql);
        const model = /FROM core\."([^"]+)" s WHERE/.exec(sql)?.[1] ?? '?';
        if (o.failOnCopy && o.failOnCopy.model === model) {
          const s = new PassThrough();
          setImmediate(() => s.destroy(o.failOnCopy!.error));
          return s;
        }
        const text = o.csv?.[model] ?? 'id\n';
        // Split mid-record so the counter has to carry quote state across chunks.
        const mid = Math.floor(text.length / 2);
        return Readable.from([Buffer.from(text.slice(0, mid)), Buffer.from(text.slice(mid))]);
      },
      release: () => {
        this.released++;
      },
    };
  }
}

export function fakeBlobs(objects: Record<string, Buffer>, dedicatedBuckets: string[] = []) {
  const reads: string[] = [];
  const provider = {
    getObjectStream: async ({ bucket, key }: { bucket: string; key: string }) => {
      reads.push(`${bucket}/${key}`);
      const b = objects[`${bucket}/${key}`];
      if (!b) throw Object.assign(new Error('The specified key does not exist.'), { name: 'NoSuchKey' });
      return Readable.from([b]);
    },
  };
  return {
    reads,
    factory: {
      getProvider: async () => provider,
      getProviderForBucket: async () => provider,
      resolveDescriptorForBucket: async (_t: string, bucket: string) => (dedicatedBuckets.includes(bucket) ? { provider: 'minio', bucket } : null),
    } as any,
  };
}

export function fakeSettings(values: Record<string, number> = {}) {
  return {
    resolve: (key: string) => ({ value: values[key] ?? (key.endsWith('retentionDays') ? 30 : key.endsWith('maxRetained') ? 10 : 60) }),
  } as any;
}

export function fakeCls() {
  const store = new Map<string, unknown>();
  return {
    run: async (a: unknown, b?: unknown) => ((typeof a === 'function' ? a : b) as () => unknown)(),
    isActive: () => false,
    set: (k: string, v: unknown) => store.set(k, v),
    get: (k: string) => store.get(k),
    getId: () => 'req',
  } as any;
}

export function fakeEvents() {
  const emitted: { type: string; payload: any }[] = [];
  return { emitted, emitter: { emit: (type: string, payload: unknown) => emitted.push({ type, payload }) } as any };
}

export function fakeRedis(held = false) {
  const calls: string[] = [];
  return {
    calls,
    redis: {
      eval: async () => {
        calls.push('eval');
        return held ? null : 'OK';
      },
      del: async () => {
        calls.push('del');
        return 1;
      },
    } as any,
  };
}
