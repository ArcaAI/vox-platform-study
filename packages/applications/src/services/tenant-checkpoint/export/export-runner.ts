/**
 * The export runner: one tenant's registry tables, read inside ONE `REPEATABLE READ READ ONLY`
 * snapshot via `COPY … TO STDOUT (FORMAT csv, HEADER)`, gzipped and streamed into the sealed
 * archive; then (when the checkpoint includes media) the tenant's SHARED-bucket media objects and
 * claim-check blobs; then the manifest and the signed trailer.
 *
 * Durable state lives on the `TenantCheckpoint` row: `RUNNING` + a 15 s heartbeat while it runs,
 * `READY` / `FAILED` / `CANCELLED` at the end. A cancel recorded on the row is honoured between
 * every table and every object. `failureDetail` never carries a driver message or a stack.
 */
import { createGzip } from 'node:zlib';
import { pipeline, type Readable } from 'node:stream';
import { Inject, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { ClsService } from 'nestjs-cls';
import { ResourceType, SysEventType, TenantCheckpointRepository, TenantCheckpointStatus, type TenantCheckpointEntity } from '@arcaai/domains';

import { BaseService } from '../../../common/base.service';
import { parseStorageUri } from '../../../common/storage-uri';
import { createWorkerSession } from '../../../common/worker-session';
import { IActiveUserContext } from '../../../interfaces';
import { BlobStorageProviderFactory } from '../../baseServices/storage/providers/blob-storage.provider.factory';
import { TENANT_CHECKPOINT_RETENTION_DAYS_KEY } from '../../settings-registry/descriptors/tenant-checkpoint.descriptors';
import { TenantSettingsService } from '../../settings-registry/tenant-settings.service';
import { CLAIM_CHECK_BUCKET } from '../../workflow-exposure/claim-check';
import { createArchiveWriter, tableEntryName } from '../archive';
import {
  CheckpointError,
  ICheckpointSealing,
  ICheckpointStore,
  type CheckpointArchiveWriter,
  type CheckpointHeader,
  type CheckpointManifest,
  type CheckpointModelDescriptor,
  type ICheckpointExportRunner,
  type KeyEnvelope,
  type ManifestSummary,
  type ManifestTable,
  type SqlQuery,
} from '../contracts';
import { CHECKPOINT_REGISTRY, descriptorFor, tableName } from '../registry/registry';
import { currentColumns, schemaFingerprint } from '../registry/schema';
import { scopePredicate } from '../registry/scope';
import { describeFailure, patchCheckpoint, findCheckpoint, RowHeartbeat, writeHeartbeat } from './checkpoint-row';
import { CHECKPOINT_DB_CONNECTOR, type CheckpointDbConnector, type CheckpointDbSession } from './db-connector';
import { CsvRecordCounter } from './csv-record-counter';

const UUID = /^[0-9a-f-]{36}$/;
/** `pg_export_snapshot()` output, e.g. `00000003-0000001B-1`. */
const SNAPSHOT_ID = /^[0-9A-Fa-f]+(-[0-9A-Fa-f]+)+$/;
const DAY_MS = 86_400_000;
const CIPHERTEXT_COLUMN = /^encrypted|Encrypted$|Ciphertext$/;

/** COPY takes no bind parameters: inline the (already validated) tenant id as a quoted literal. */
export function inlineTenant(sql: string, tenantId: string): string {
  if (!UUID.test(tenantId)) throw new CheckpointError('EXPORT_FAILED', 'The tenant id is not a UUID');
  return sql.replace(/\$1(?!\d)/g, `'${tenantId}'`);
}

const quoteIdent = (c: string) => `"${c.replace(/"/g, '""')}"`;

export function isMissingObject(error: unknown): boolean {
  if (error instanceof NotFoundException) return true;
  const e = error as { name?: unknown; code?: unknown; status?: unknown; statusCode?: unknown; $metadata?: { httpStatusCode?: number } } | null;
  if (!e) return false;
  return (
    e.name === 'NoSuchKey' ||
    e.name === 'NotFound' ||
    e.code === 'NoSuchKey' ||
    e.code === 'BlobNotFound' ||
    e.status === 404 ||
    e.statusCode === 404 ||
    e.$metadata?.httpStatusCode === 404
  );
}

interface MediaRef {
  id: string;
  bucketId: string | null;
  uri: string;
}

/** Options of one export run. */
export interface CheckpointExportRunOptions {
  /**
   * Read the snapshot another open transaction exported with `pg_export_snapshot()` instead of a
   * fresh one (`SET TRANSACTION SNAPSHOT`). The restore uses it so its SAFETY checkpoint sees exactly
   * what its reconcile transaction sees. The exporting transaction must stay open until this returns.
   */
  snapshotId?: string;
}

/** SELECT list of one table: a redacted column is exported as NULL under its own name. */
export function exportSelectList(d: CheckpointModelDescriptor, cols: readonly string[]): string {
  const redacted = new Set(d.redactColumns ?? []);
  return cols.map((c) => (redacted.has(c) ? `NULL AS ${quoteIdent(c)}` : `s.${quoteIdent(c)}`)).join(', ');
}

interface Progress {
  phase: 'tables' | 'media' | 'finishing';
  tablesDone: number;
  tablesTotal: number;
  bytesWritten: number;
}

@Injectable()
export class CheckpointExportRunner extends BaseService implements ICheckpointExportRunner {
  private readonly logger = new Logger(CheckpointExportRunner.name);
  /** Liveness interval; the stale-export sweeper fails a RUNNING row silent for 2 minutes. */
  heartbeatIntervalMs = 15_000;
  now: () => Date = () => new Date();

  constructor(
    private readonly checkpoints: TenantCheckpointRepository,
    @Inject(CHECKPOINT_DB_CONNECTOR) private readonly db: CheckpointDbConnector,
    @Inject(ICheckpointSealing) private readonly sealing: ICheckpointSealing,
    @Inject(ICheckpointStore) private readonly store: ICheckpointStore,
    private readonly blobs: BlobStorageProviderFactory,
    private readonly settings: TenantSettingsService,
    protected override readonly eventEmitter: EventEmitter2,
    protected override readonly clsService: ClsService<IActiveUserContext>,
  ) {
    super(eventEmitter, clsService, ResourceType.TenantCheckpoint);
  }

  async run(checkpointId: string, options: CheckpointExportRunOptions = {}): Promise<void> {
    const row = await findCheckpoint(this.checkpoints, checkpointId);
    if (!row || row.status !== TenantCheckpointStatus.PENDING) return; // re-delivered job: idempotent
    await this.inTenantContext(row.tenantId, () => this.export(row, options));
  }

  private async inTenantContext(tenantId: string, work: () => Promise<void>): Promise<void> {
    const body = async () => {
      this.clsService.set('tenantId', tenantId);
      this.clsService.set('user', createWorkerSession({ tenantId, kind: 'tenant-checkpoint-export' }) as never);
      await work();
    };
    if (this.clsService.isActive()) await body();
    else await this.clsService.run(body);
  }

  private async export(initial: TenantCheckpointEntity, options: CheckpointExportRunOptions): Promise<void> {
    const id = initial.id;
    const tenantId = initial.tenantId;
    const descriptors = CHECKPOINT_REGISTRY.filter((d) => d.policy !== 'EXCLUDED');
    const progress: Progress = { phase: 'tables', tablesDone: 0, tablesTotal: descriptors.length, bytesWritten: 0 };
    const cancel = { requested: false };
    const heartbeat = new RowHeartbeat(
      this.heartbeatIntervalMs,
      () => writeHeartbeat(this.checkpoints, id, this.now(), { ...progress }, () => (cancel.requested = true)),
      (error) => this.logger.warn({ message: 'Checkpoint heartbeat write failed', checkpointId: id, error: errorName(error) }),
    );

    let session: CheckpointDbSession | undefined;
    let upload: ReturnType<ICheckpointStore['openWriteStream']> | undefined;
    let writer: CheckpointArchiveWriter | undefined;
    let dataKey: Buffer | undefined;

    try {
      if (!UUID.test(tenantId)) throw new CheckpointError('EXPORT_FAILED', 'The tenant id is not a UUID');
      if (options.snapshotId !== undefined && !SNAPSHOT_ID.test(options.snapshotId)) {
        throw new CheckpointError('EXPORT_FAILED', 'The snapshot id is malformed');
      }
      const objectKey = this.store.objectKey(tenantId, id);
      const started = this.now();
      const running = await patchCheckpoint(this.checkpoints, id, (row) => {
        if (row.status !== TenantCheckpointStatus.PENDING) return false;
        row.status = TenantCheckpointStatus.RUNNING;
        row.startedAt = started;
        row.heartbeatAt = started;
        row.objectKey = objectKey;
        row.progress = { ...progress } as never;
      });
      if (!running) return; // another delivery took it
      heartbeat.start();

      const envelope = running.keyEnvelope as unknown as KeyEnvelope | null;
      if (!envelope?.platform) throw new CheckpointError('EXPORT_FAILED', 'The checkpoint has no key envelope');
      dataKey = await this.sealing.unwrapPlatform(envelope.platform);

      // ---- snapshot ------------------------------------------------------------------------
      session = await this.db.connect();
      const q = session.query;
      await q('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      if (options.snapshotId) await q(`SET TRANSACTION SNAPSHOT '${options.snapshotId}'`);
      const fingerprint = await schemaFingerprint(q);
      const [tenant] = await q<{ t: Record<string, unknown> }>('SELECT row_to_json(t) AS t FROM core."Tenant" t WHERE t."id" = $1', [tenantId]);
      if (!tenant?.t) throw new CheckpointError('EXPORT_FAILED', 'The tenant row was not found');
      const columns = await currentColumns(
        q,
        descriptors.map((d) => d.model),
      );

      const header: Omit<CheckpointHeader, 'magic' | 'formatVersion' | 'noncePrefix'> = {
        checkpointId: id,
        tenantId,
        tenantKey: String(tenant.t.key ?? ''),
        sourceDeploymentId: await this.sealing.deploymentId(),
        createdAt: (running.createdAt ?? started).toISOString(),
        schemaFingerprint: fingerprint,
        includesMedia: running.includesMedia,
        keys: envelope,
      };
      upload = this.store.openWriteStream(objectKey);
      writer = createArchiveWriter({ header, dataKey, sink: upload.stream, sealing: this.sealing });
      const w = writer;
      const add = async (name: string, body: Readable | Buffer) => {
        const r = await w.writeEntry(name, body);
        progress.bytesWritten += r.bytes;
        return r;
      };

      await add('tenant.json', Buffer.from(JSON.stringify(tenant.t), 'utf8'));

      const tables: ManifestTable[] = [];
      const transitKeyVersions: Record<string, number> = {};
      const notCaptured: string[] = [];
      for (const d of descriptors) {
        await this.checkCancel(id, cancel);
        const cols = columns[d.model] ?? [];
        if (cols.length === 0) {
          notCaptured.push(`table:${d.model}:MISSING`);
          continue;
        }
        const select = `SELECT ${exportSelectList(d, cols)} FROM ${tableName(d)} s WHERE ${scopePredicate(d, 's')}`;
        const counter = new CsvRecordCounter();
        const source = session.copyOut(inlineTenant(`COPY (${select}) TO STDOUT (FORMAT csv, HEADER)`, tenantId));
        const gz = pipeline(source, counter, createGzip(), () => undefined);
        const { sha256 } = await add(tableEntryName(d.model), gz);
        tables.push({ model: d.model, columns: cols, rowCount: counter.rows, sha256 });
        Object.assign(transitKeyVersions, await this.transitVersions(q, d, cols, tenantId));
        progress.tablesDone++;
      }

      let media: MediaRef[] = [];
      let refs: unknown[] = [];
      if (running.includesMedia) {
        const m = descriptorFor('Media');
        media = await q<MediaRef>(`SELECT s."id", s."bucketId", s."uri" FROM ${tableName(m)} s WHERE ${scopePredicate(m, 's')} ORDER BY s."id"`, [
          tenantId,
        ]);
        refs = await this.claimCheckRefs(q, tenantId);
      }
      await q('COMMIT');
      session.release();
      session = undefined;

      // ---- objects -------------------------------------------------------------------------
      progress.phase = 'media';
      const manifest: CheckpointManifest = {
        formatVersion: 1,
        schemaFingerprint: fingerprint,
        tables,
        media: [],
        claimChecks: [],
        transitKeyVersions,
        notCaptured,
      };
      for (const row of media) {
        await this.checkCancel(id, cancel);
        const loc = parseStorageUri(row.uri);
        if (!loc) {
          notCaptured.push(`media:${row.id}:UNRESOLVABLE_URI`);
          continue;
        }
        if (await this.blobs.resolveDescriptorForBucket(tenantId, loc.bucket)) {
          notCaptured.push(`media:${row.id}:DEDICATED_BUCKET`);
          continue;
        }
        const body = await this.openObject(() => this.blobs.getProviderForBucket(tenantId, loc.bucket), loc.bucket, loc.key);
        if (!body) {
          notCaptured.push(`media:${row.id}:MISSING`);
          continue;
        }
        const bucketId = row.bucketId ?? loc.bucket;
        const entry = `media/${bucketId}/${loc.key}`;
        const r = await add(entry, body);
        manifest.media.push({ entry, size: r.bytes, sha256: r.sha256, bucketId, key: loc.key });
      }
      for (const ref of dedupeRefs(refs)) {
        await this.checkCancel(id, cancel);
        if (ref.store !== 's3') {
          notCaptured.push(`claimcheck:${ref.key}:UNSUPPORTED_STORE`);
          continue;
        }
        // Platform credentials read this object: never follow a bucket named in DB JSON (R1 M-5).
        if (ref.bucket !== CLAIM_CHECK_BUCKET) {
          notCaptured.push(`claimcheck:${ref.key}:FOREIGN_BUCKET`);
          continue;
        }
        const body = await this.openObject(() => this.blobs.getProvider(), ref.bucket, ref.key);
        if (!body) {
          notCaptured.push(`claimcheck:${ref.key}:MISSING`);
          continue;
        }
        const entry = `claimcheck/${ref.key}`;
        const r = await add(entry, body);
        manifest.claimChecks.push({ entry, size: r.bytes, sha256: r.sha256, contentKey: ref.key });
      }

      // ---- seal ----------------------------------------------------------------------------
      await this.checkCancel(id, cancel);
      progress.phase = 'finishing';
      const sealed = await writer.finish(manifest);
      await upload.done;
      heartbeat.stop();

      const finished = this.now();
      const retentionDays = this.settings.resolve<number>(TENANT_CHECKPOINT_RETENTION_DAYS_KEY, tenantId).value;
      const summary: ManifestSummary = { tables: tables.map((t) => ({ model: t.model, columns: t.columns, rowCount: t.rowCount })) };
      await patchCheckpoint(this.checkpoints, id, (row) => {
        row.status = TenantCheckpointStatus.READY;
        row.sizeBytes = sealed.sizeBytes;
        row.manifestDigest = sealed.manifestDigestHex;
        row.manifestSummary = summary as never;
        row.schemaFingerprint = fingerprint;
        row.sourceDeploymentId = header.sourceDeploymentId;
        row.objectKey = objectKey;
        row.finishedAt = finished;
        row.heartbeatAt = finished;
        row.expiresAt = new Date(finished.getTime() + retentionDays * DAY_MS);
        row.progress = { ...progress } as never;
        row.failureReason = null;
        row.failureDetail = null;
      });
      this.broadcastSysEvent(SysEventType.ResourceUpdated, {
        resourceId: id,
        data: { status: TenantCheckpointStatus.READY, sizeBytes: sealed.sizeBytes, tables: tables.length, media: manifest.media.length },
      });
    } catch (error) {
      heartbeat.stop();
      if (session) {
        // swallow-ok: a failed ROLLBACK means the connection is gone; it is released with the error and destroyed
        await session.query('ROLLBACK').catch(() => undefined);
        session.release(error instanceof Error ? error : undefined);
        session = undefined;
      }
      await writer
        ?.abort(error instanceof Error ? error : new Error('checkpoint export failed'))
        .catch((e) => this.logger.warn({ message: 'Checkpoint archive writer abort failed', checkpointId: id, error: errorName(e) }));
      await upload?.abort().catch((e) => this.logger.warn({ message: 'Checkpoint upload abort failed', checkpointId: id, error: errorName(e) }));
      await this.recordFailure(id, error);
    } finally {
      heartbeat.stop();
      dataKey?.fill(0);
    }
  }

  private async recordFailure(id: string, error: unknown): Promise<void> {
    const cancelled = error instanceof CheckpointError && error.reason === 'CANCELLED';
    const { reason, detail } = describeFailure(error);
    if (!cancelled) this.logger.error({ message: 'Checkpoint export failed', checkpointId: id, reason, error: errorName(error) });
    const now = this.now();
    await patchCheckpoint(this.checkpoints, id, (row) => {
      if (row.status !== TenantCheckpointStatus.RUNNING && row.status !== TenantCheckpointStatus.PENDING) return false;
      row.status = cancelled ? TenantCheckpointStatus.CANCELLED : TenantCheckpointStatus.FAILED;
      row.failureReason = cancelled ? null : reason;
      row.failureDetail = cancelled ? null : detail;
      row.finishedAt = now;
    }).catch((e) => this.logger.error({ message: 'Could not record the checkpoint export outcome', checkpointId: id, error: errorName(e) }));
    this.broadcastSysEvent(SysEventType.ResourceUpdated, {
      resourceId: id,
      data: { status: cancelled ? TenantCheckpointStatus.CANCELLED : TenantCheckpointStatus.FAILED, ...(cancelled ? {} : { failureReason: reason }) },
    });
  }

  /** Between every table and every object: a cancel recorded on the row (or seen by the heartbeat) stops the export. */
  private async checkCancel(id: string, cancel: { requested: boolean }): Promise<void> {
    if (!cancel.requested) {
      const row = await findCheckpoint(this.checkpoints, id);
      if (!row || row.cancelRequestedAt) cancel.requested = true;
    }
    if (cancel.requested) throw new CheckpointError('CANCELLED', 'The export was cancelled');
  }

  /** Highest Vault Transit key version seen per ciphertext column of this table, inside the snapshot. */
  private async transitVersions(q: SqlQuery, d: CheckpointModelDescriptor, cols: string[], tenantId: string): Promise<Record<string, number>> {
    const cipher = cols.filter((c) => CIPHERTEXT_COLUMN.test(c));
    if (cipher.length === 0) return {};
    const selects = cipher.map((c, i) => `max(substring(s.${quoteIdent(c)}::text from 'vault:v([0-9]+):')::int) AS "v${i}"`);
    const [row] = await q<Record<string, number | null>>(`SELECT ${selects.join(', ')} FROM ${tableName(d)} s WHERE ${scopePredicate(d, 's')}`, [
      tenantId,
    ]);
    const out: Record<string, number> = {};
    cipher.forEach((c, i) => {
      const v = row?.[`v${i}`];
      if (typeof v === 'number') out[`${d.model}.${c}`] = v;
    });
    return out;
  }

  private async claimCheckRefs(q: SqlQuery, tenantId: string): Promise<unknown[]> {
    const run = descriptorFor('WorkflowRun');
    const step = descriptorFor('AgentTrajectoryStep');
    const rows = await q<{ ref: unknown }>(
      `SELECT s."resultRef" AS ref FROM ${tableName(run)} s WHERE ${scopePredicate(run, 's')} AND s."resultRef" IS NOT NULL ` +
        `UNION ALL SELECT s."payloadRef" AS ref FROM ${tableName(step)} s WHERE ${scopePredicate(step, 's')} AND s."payloadRef" IS NOT NULL`,
      [tenantId],
    );
    return rows.map((r) => r.ref);
  }

  /** Opens an object; a missing object resolves `null` (recorded as not captured), any other failure throws. */
  private async openObject(
    provider: () => Promise<{ getObjectStream(p: { bucket: string; key: string }): Promise<Readable> }>,
    bucket: string,
    key: string,
  ): Promise<Readable | null> {
    try {
      return await (await provider()).getObjectStream({ bucket, key });
    } catch (error) {
      if (isMissingObject(error)) return null;
      throw error;
    }
  }
}

interface ClaimRef {
  store: string;
  bucket: string;
  key: string;
}

/** Claim-check refs (`{ store, bucket, key, … }`, possibly wrapped as `{ resultRef: … }`), deduplicated by key. */
export function dedupeRefs(raw: unknown[]): ClaimRef[] {
  const out = new Map<string, ClaimRef>();
  for (const value of raw) {
    let ref = (typeof value === 'string' ? safeJson(value) : value) as Record<string, unknown> | null;
    if (ref && typeof ref.resultRef === 'object' && ref.resultRef) ref = ref.resultRef as Record<string, unknown>;
    if (!ref || typeof ref.key !== 'string' || !ref.key || ref.key.includes('..')) continue;
    if (!out.has(ref.key)) {
      out.set(ref.key, {
        store: typeof ref.store === 'string' ? ref.store : 's3',
        bucket: typeof ref.bucket === 'string' && ref.bucket ? ref.bucket : CLAIM_CHECK_BUCKET,
        key: ref.key,
      });
    }
  }
  return [...out.values()];
}

function safeJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return null;
  }
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}
