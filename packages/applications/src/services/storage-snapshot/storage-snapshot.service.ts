import { Inject, Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { SchedulerRegistry } from '@nestjs/schedule';
import { OnEvent } from '@nestjs/event-emitter';
import { CronJob } from 'cron';
import Decimal from 'decimal.js';
import { AiCapability, AiCostBasis, AiDeploymentKind, AiUsageUnit, CoreDatabaseService, ResourceStatusType } from '@arcaai/domains';

import { IAppSettingsService } from '../baseServices/_meta/appSettings/IAppSettingsService';
import { IUsageLedgerService } from '../usageLedger/IUsageLedgerService';
import type { UsageEventInput } from '../usageLedger/dto';
import type { StorageClass } from '../usageLedger/usage-attributes';
import { IStorageSnapshotService, StorageSnapshotResult, StorageSnapshotRow } from './IStorageSnapshotService';
import {
  BYTES_PER_GIGABYTE,
  STORAGE_GB_DECIMAL_PLACES,
  STORAGE_SNAPSHOT_CRON_KEY,
  STORAGE_SNAPSHOT_DEFAULTS,
  STORAGE_SNAPSHOT_ENABLED_KEY,
  STORAGE_SNAPSHOT_JOB_NAME,
} from './storage-snapshot.constants';

const MS_PER_DAY = 24 * 60 * 60 * 1000;

/** The frozen operation for every row this job writes (`vocabulary.ts`). */
const STORAGE_OPERATION = 'storage.snapshot';

/** One row of a per-tenant byte aggregate. `bytes` arrives as a `bigint` from raw SQL. */
interface TenantBytesRow {
  tenantId: string;
  bytes: bigint | number | string | null;
}

/**
 * The encrypted `Bytes?` columns whose stored size IS the tenant's Postgres
 * footprint (ticket §5.1), table by table.
 *
 * Verified column-by-column against the schema on this branch — a name that
 * does not exist makes the statement throw at runtime, and a name that exists
 * but was FORGOTTEN under-bills silently, which is why the list is stated once
 * here rather than inlined in seven near-identical query strings.
 *
 * Every one of these is `Bytes?`, so every one needs the NULL guard below:
 * `pg_column_size` is not strict, so summing it over a NULL column would add a
 * small per-row constant for content that does not exist.
 */
const TEXT_BYTE_COLUMNS: ReadonlyArray<{ table: string; columns: readonly string[] }> = [
  { table: 'ContextItem', columns: ['encryptedContent'] },
  { table: 'ContextItemVersion', columns: ['encryptedContent', 'encryptedContentDiff', 'encryptedChangeSummary', 'encryptedFieldChanges'] },
  { table: 'DocumentSection', columns: ['encryptedContent'] },
  { table: 'NamedEntity', columns: ['encryptedText', 'encryptedNormalizedText', 'encryptedMetadata'] },
  { table: 'Highlight', columns: ['encryptedExact', 'encryptedPrefix', 'encryptedSuffix', 'encryptedNote'] },
  { table: 'KnowledgeChunk', columns: ['encryptedText'] },
  { table: 'TranscriptionJob', columns: ['encryptedResultText', 'encryptedResultMetadata'] },
];

/** UTC midnight of the day `at` falls in. */
function truncateToUtcDay(at: Date): Date {
  return new Date(Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate()));
}

/** `YYYY-MM-DD` of a UTC-midnight day — the idempotency key's date component. */
function utcDayKey(day: Date): string {
  return day.toISOString().slice(0, 10);
}

function toBigIntSafe(value: bigint | number | string | null | undefined): bigint {
  if (value === null || value === undefined) return 0n;
  if (typeof value === 'bigint') return value;
  return BigInt(Math.trunc(Number(value)));
}

/**
 * The nightly per-(tenant, storage class) GB-day snapshot (TASK-959 §5.2).
 *
 * SHAPE. `MeteringService`'s, deliberately: config from
 * {@link IAppSettingsService}, re-synced on `app-settings.cache-refreshed`, one
 * self-scheduled `CronJob`, every query on the UNSCOPED base client with an
 * explicit tenant grouping because the job runs with no CLS tenant context.
 *
 * WHAT IT DOES NOT DO. It does not write the ledger. It hands every row to
 * `IUsageLedgerService.recordUsage`, which writes an outbox row the drainer
 * later rates and appends — so a snapshot can never be half-recorded, and a
 * re-run converges on one ledger row per (tenant, class, day) at the drainer
 * rather than double-counting. That is what makes backfilling a missed night
 * safe, and it is the whole reason the key is intent-derived.
 *
 * ONE SWEEP, NOT N SWEEPS. `snapshotAll` issues the nine aggregates ONCE,
 * grouped by `tenantId`, and then loops the tenants to emit. Running them per
 * tenant would turn a nine-query job into a nine-times-N-query job for numbers
 * Postgres can group in a single pass.
 *
 * THREE DELIBERATE MEASUREMENT CHOICES, each stated because each is arguable:
 *
 *   1. **Media excludes soft-deleted rows.** The live console figure
 *      (`TenantService.getUsageStats`) reads the EXTENDED client, which filters
 *      `resourceStatus: DELETED`. Two surfaces reporting one tenant's storage
 *      must agree, so the snapshot applies the same filter explicitly.
 *   2. **Text does NOT.** `pg_column_size` measures what the disk holds, and a
 *      soft-deleted row is still on the disk. Excluding it would report a
 *      figure Postgres would not recognise. The asymmetry with (1) is real and
 *      intended: one class measures objects the platform could delete, the
 *      other measures bytes it is still storing.
 *   3. **A DEDICATED-topology tenant's MEDIA is skipped, and only its media.**
 *      Those objects live in the tenant's own S3/Azure account and are not
 *      platform storage (§5.1 hole 4). Its Postgres text and its claim-check
 *      payloads are still on platform hardware, so those classes are recorded
 *      as usual. Because `Media.bucketId` is never populated (§5.1 hole 3) a
 *      per-bucket split is impossible, so a tenant with ANY dedicated storage
 *      config has its whole media class skipped — under-reporting, which is
 *      the correctable direction; over-billing a tenant for bytes it holds in
 *      its own account is not.
 */
@Injectable()
export class StorageSnapshotService implements IStorageSnapshotService, OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(StorageSnapshotService.name);
  private activeCron: string | null = null;

  constructor(
    @Inject(IAppSettingsService) private readonly appSettings: IAppSettingsService,
    private readonly schedulerRegistry: SchedulerRegistry,
    // Platform-wide sweep with no CLS tenant context — the same sanctioned
    // escape hatch `MeteringService.reconcileAllActiveTenants` uses. Every
    // query below carries an explicit `tenantId` filter or grouping.
    @Inject('CORE_DATABASE_SERVICE') private readonly databaseService: CoreDatabaseService,
    @Inject(IUsageLedgerService) private readonly usageLedger: IUsageLedgerService,
  ) {}

  onModuleInit(): void {
    this.syncSchedulerFromConfig();
  }

  onModuleDestroy(): void {
    this.stopJob();
  }

  @OnEvent('app-settings.cache-refreshed')
  onSettingsRefreshed(): void {
    this.syncSchedulerFromConfig();
  }

  // ── Public snapshot API ──────────────────────────────────────────────────

  async snapshotTenant(tenantId: string, day: Date): Promise<StorageSnapshotResult> {
    const utcDay = truncateToUtcDay(day);
    const { byTenant, dedicated } = await this.collectBytes(tenantId);
    const result = this.buildResult(tenantId, utcDay, byTenant.get(tenantId), dedicated.has(tenantId));
    await this.emit(result);
    return result;
  }

  async snapshotAll(day: Date): Promise<{ tenants: number; rows: number }> {
    const utcDay = truncateToUtcDay(day);
    // Unscoped read of every tenant id — the job has no CLS tenant context.
    const tenants = await this.databaseService.baseClient.tenant.findMany({ select: { id: true } });
    const { byTenant, dedicated } = await this.collectBytes(null);

    let tenantCount = 0;
    let rowCount = 0;
    for (const tenant of tenants) {
      const result = this.buildResult(tenant.id, utcDay, byTenant.get(tenant.id), dedicated.has(tenant.id));
      if (result.rows.length === 0) continue;
      try {
        await this.emit(result);
        tenantCount += 1;
        rowCount += result.rows.length;
      } catch (error) {
        // One tenant's outbox write must not abandon the rest of the night —
        // and the key is intent-derived, so the next run repairs this tenant.
        this.logger.error(
          `Storage snapshot failed for tenant ${tenant.id} on ${utcDayKey(utcDay)}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return { tenants: tenantCount, rows: rowCount };
  }

  // ── Config + scheduling (mirrors MeteringService) ────────────────────────

  getConfig(): { enabled: boolean; cron: string } {
    return {
      enabled: this.appSettings.getValueWithDefault<boolean>(STORAGE_SNAPSHOT_ENABLED_KEY, STORAGE_SNAPSHOT_DEFAULTS.enabled),
      cron: this.appSettings.getValueWithDefault<string>(STORAGE_SNAPSHOT_CRON_KEY, STORAGE_SNAPSHOT_DEFAULTS.cron),
    };
  }

  get isEnabled(): boolean {
    return this.getConfig().enabled;
  }

  /**
   * The scheduled body — snapshots the UTC day that just CLOSED.
   *
   * Never the day in progress: a partial day's bytes are not the day's level,
   * and the key would then be rewritten by the next tick with a different
   * number under the same idempotency key, which the drainer would ignore.
   */
  async handleScheduledSnapshot(): Promise<void> {
    if (!this.isEnabled) {
      this.logger.debug('Storage snapshot is disabled — skipping tick');
      return;
    }

    const day = new Date(truncateToUtcDay(new Date()).getTime() - MS_PER_DAY);
    try {
      const { tenants, rows } = await this.snapshotAll(day);
      this.logger.log({ message: 'Storage snapshot completed', day: utcDayKey(day), tenants, rows });
    } catch (error) {
      this.logger.error(`Storage snapshot tick failed: ${error instanceof Error ? error.message : String(error)}`);
    }
  }

  syncSchedulerFromConfig(): void {
    const { enabled, cron } = this.getConfig();

    if (!enabled) {
      if (this.activeCron) {
        this.logger.log('Storage snapshot disabled via settings — stopping scheduler');
        this.stopJob();
      }
      return;
    }

    if (cron === this.activeCron) return;

    this.replaceJob(cron);
  }

  // ── Internals ────────────────────────────────────────────────────────────

  /**
   * The nine aggregates, issued ONCE and grouped by tenant.
   *
   * @param tenantId a single tenant, or `null` for the whole platform.
   */
  private async collectBytes(
    tenantId: string | null,
  ): Promise<{ byTenant: Map<string, { media: bigint; text: bigint; claimCheck: bigint }>; dedicated: Set<string> }> {
    const client = this.databaseService.baseClient;
    const tenantFilter = tenantId ? { tenantId } : {};

    const [mediaRows, dedicatedRows, textRows, claimCheckRows] = await Promise.all([
      // The existing live figure (`TenantService.getUsageStats`), grouped and
      // persisted instead of recomputed — including its soft-delete filter,
      // which the extended client applies there and the base client does not.
      client.media.groupBy({
        by: ['tenantId'],
        _sum: { size: true },
        where: { ...tenantFilter, resourceStatus: { not: ResourceStatusType.DELETED } },
      }),
      client.tenantStorageConfig.findMany({
        where: { ...tenantFilter, topology: 'DEDICATED', resourceStatus: { not: ResourceStatusType.DELETED } },
        select: { tenantId: true },
        distinct: ['tenantId'],
      }),
      this.sumTextBytes(tenantId),
      this.sumClaimCheckBytes(tenantId),
    ]);

    const byTenant = new Map<string, { media: bigint; text: bigint; claimCheck: bigint }>();
    const bucket = (id: string) => {
      const existing = byTenant.get(id);
      if (existing) return existing;
      const fresh = { media: 0n, text: 0n, claimCheck: 0n };
      byTenant.set(id, fresh);
      return fresh;
    };

    for (const row of mediaRows as Array<{ tenantId: string; _sum: { size: number | null } }>) {
      bucket(row.tenantId).media += toBigIntSafe(row._sum.size);
    }
    for (const row of textRows) bucket(row.tenantId).text += toBigIntSafe(row.bytes);
    for (const row of claimCheckRows) bucket(row.tenantId).claimCheck += toBigIntSafe(row.bytes);

    return { byTenant, dedicated: new Set((dedicatedRows as Array<{ tenantId: string }>).map((row) => row.tenantId)) };
  }

  /**
   * `SUM(pg_column_size(col))` per tenant over the seven encrypted-column
   * tables — ONE statement per table, each a grouped scan on that table's
   * `tenantId` index.
   *
   * `pg_column_size` reports the STORED size (TOASTed and compressed), which is
   * what the disk actually holds; a plaintext `octet_length` would bill the
   * tenant for bytes Postgres never wrote. The `CASE ... IS NULL THEN 0` guard
   * is not defensive noise: `pg_column_size` is not strict, so a NULL column
   * would otherwise contribute a small constant per row for content that is
   * absent.
   *
   * Soft-deleted rows are deliberately INCLUDED — see the class header, choice 2.
   *
   * `$queryRawUnsafe` because the column list varies per table, so there is no
   * one template literal to tag; it is unsafe only in NAME here. Every
   * identifier interpolated into the string is a compile-time constant from
   * {@link TEXT_BYTE_COLUMNS}, and the single runtime value — the tenant
   * filter — is a BOUND parameter (`$1`), never concatenated. Same shape, and
   * the same reasoning, as `UserVoiceProfileRepository.findActiveEmbeddingsForUser`.
   */
  private async sumTextBytes(tenantId: string | null): Promise<TenantBytesRow[]> {
    const results = await Promise.all(
      TEXT_BYTE_COLUMNS.map(({ table, columns }) => {
        const sizeExpression = columns.map((column) => `CASE WHEN "${column}" IS NULL THEN 0 ELSE pg_column_size("${column}") END`).join(' + ');
        return this.groupedBytesQuery(
          `SELECT "tenantId", COALESCE(SUM(${sizeExpression}), 0)::bigint AS "bytes" FROM "core"."${table}"`,
          null,
          tenantId,
        );
      }),
    );

    return results.flat();
  }

  /**
   * The two claim-check aggregates.
   *
   * `AgentTrajectoryStep.payloadRef` is a `ClaimCheckRef` VERBATIM
   * (`{store, bucket, key, size, sha256, content_type}`), so the byte count is
   * `payloadRef->>'size'`. `WorkflowRun.resultRef` is one level deeper: it
   * stores the deliver node's OUTPUT verbatim, a discriminated union of
   * `{resultRef: ClaimCheckRef}` (offloaded) or `{outputs: {...}}` (inline), so
   * only the first branch carries bytes in the claim-check bucket at all.
   *
   * Both are guarded by `jsonb_typeof(...) = 'number'` rather than trusting the
   * cast: `payloadRef` is ALSO written with non-claim-check shapes (the live
   * documentation lane records an agent/prompt provenance object there), and a
   * blind `::bigint` on a future shape that happened to carry a non-numeric
   * `size` would fail the whole night's sweep instead of skipping one row.
   */
  private async sumClaimCheckBytes(tenantId: string | null): Promise<TenantBytesRow[]> {
    const results = await Promise.all([
      this.groupedBytesQuery(
        `SELECT "tenantId", COALESCE(SUM(("payloadRef"->>'size')::bigint), 0)::bigint AS "bytes" FROM "core"."AgentTrajectoryStep"`,
        `jsonb_typeof("payloadRef"->'size') = 'number'`,
        tenantId,
      ),
      this.groupedBytesQuery(
        `SELECT "tenantId", COALESCE(SUM(("resultRef"->'resultRef'->>'size')::bigint), 0)::bigint AS "bytes" FROM "core"."WorkflowRun"`,
        `jsonb_typeof("resultRef"->'resultRef'->'size') = 'number'`,
        tenantId,
      ),
    ]);

    return results.flat();
  }

  /**
   * Finish and run one per-tenant byte aggregate.
   *
   * The tenant predicate is APPENDED here rather than written into each
   * statement, so the platform sweep (`tenantId === null`) issues a query with
   * no redundant predicate at all and the single-tenant path binds exactly one
   * parameter. Both spellings of "which rows" therefore live in one place.
   */
  private async groupedBytesQuery(select: string, predicate: string | null, tenantId: string | null): Promise<TenantBytesRow[]> {
    const conditions = [...(predicate ? [predicate] : []), ...(tenantId ? ['"tenantId" = $1'] : [])];
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    const sql = `${select}${where} GROUP BY "tenantId"`;

    const client = this.databaseService.baseClient as unknown as {
      $queryRawUnsafe: (query: string, ...values: unknown[]) => Promise<TenantBytesRow[]>;
    };
    return tenantId ? client.$queryRawUnsafe(sql, tenantId) : client.$queryRawUnsafe(sql);
  }

  /** Turn one tenant's three byte sums into the rows that will be recorded. */
  private buildResult(
    tenantId: string,
    utcDay: Date,
    bytes: { media: bigint; text: bigint; claimCheck: bigint } | undefined,
    isDedicated: boolean,
  ): StorageSnapshotResult {
    const totals = bytes ?? { media: 0n, text: 0n, claimCheck: 0n };
    const dayKey = utcDayKey(utcDay);

    const candidates: Array<{ storageClass: StorageClass; bytes: bigint; provider: 'minio' | 'postgres' }> = [
      ...(isDedicated ? [] : [{ storageClass: 'media' as const, bytes: totals.media, provider: 'minio' as const }]),
      { storageClass: 'text', bytes: totals.text, provider: 'postgres' },
      { storageClass: 'claim-check', bytes: totals.claimCheck, provider: 'minio' },
    ];

    const rows: StorageSnapshotRow[] = candidates
      // A class holding nothing is DROPPED, not recorded as zero — the same
      // rule the multi-unit batch expansion applies to a zero token count.
      .filter((candidate) => candidate.bytes > 0n)
      .map((candidate) => ({
        tenantId,
        storageClass: candidate.storageClass,
        bytes: Number(candidate.bytes),
        quantityGb: new Decimal(candidate.bytes.toString()).div(BYTES_PER_GIGABYTE).toFixed(STORAGE_GB_DECIMAL_PLACES),
        provider: candidate.provider,
        idempotencyKey: `storage:${tenantId}:${candidate.storageClass}:${dayKey}`,
      }));

    return { tenantId, day: utcDay, rows, mediaSkippedDedicated: isDedicated };
  }

  /** Hand the rows to the emission port. Nothing is written when there are none. */
  private async emit(result: StorageSnapshotResult): Promise<void> {
    if (result.rows.length === 0) return;

    // The day's LAST millisecond. The drainer buckets a rollup on
    // `truncateToDay(occurredAt)`, so the next midnight would file the
    // snapshot under the following day — and, at a month boundary, the
    // following billing period.
    const occurredAt = new Date(result.day.getTime() + MS_PER_DAY - 1);

    const events: UsageEventInput[] = result.rows.map((row) => ({
      tenantId: row.tenantId,
      idempotencyKey: row.idempotencyKey,
      occurredAt,
      capability: AiCapability.STORAGE,
      operation: STORAGE_OPERATION,
      provider: row.provider,
      model: null,
      deployment: AiDeploymentKind.SELF_HOSTED,
      unit: AiUsageUnit.STORAGE_GB_DAY,
      quantity: row.quantityGb,
      costBasis: AiCostBasis.INTERNAL,
      attributesJson: { storageClass: row.storageClass },
    }));

    // No `tx`: there is no business transaction to join. The work being
    // recorded is a measurement the job just took, not a row it wrote.
    await this.usageLedger.recordUsage(events);
  }

  private replaceJob(cron: string): void {
    this.stopJob();

    try {
      const job = new CronJob(cron, async () => {
        await this.handleScheduledSnapshot();
      });

      // eslint-disable-next-line @typescript-eslint/no-explicit-any -- `SchedulerRegistry.addCronJob` types its argument against the `cron` version Nest was built against; ours is newer and structurally compatible. Same cast, same reason, as `MeteringService.replaceJob`.
      this.schedulerRegistry.addCronJob(STORAGE_SNAPSHOT_JOB_NAME, job as any);
      job.start();
      this.activeCron = cron;

      this.logger.log({ message: 'Storage snapshot cron job scheduled', cron });
    } catch (error) {
      this.activeCron = null;
      this.logger.error({
        message: 'Failed to schedule storage snapshot cron job',
        cron,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private stopJob(): void {
    try {
      const existing = this.schedulerRegistry.getCronJob(STORAGE_SNAPSHOT_JOB_NAME);
      if (existing) {
        existing.stop();
        this.schedulerRegistry.deleteCronJob(STORAGE_SNAPSHOT_JOB_NAME);
      }
    } catch {
      // Job doesn't exist — nothing to stop.
    }
    this.activeCron = null;
  }
}
