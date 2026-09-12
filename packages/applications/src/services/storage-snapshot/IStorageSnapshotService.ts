import type { StorageClass } from '../usageLedger/usage-attributes';

/**
 * One emitted snapshot row, as the caller sees it.
 *
 * `bytes` is what the query answered; `quantityGb` is the ledger quantity that
 * was recorded for it (a fixed-point STRING — see
 * {@link IStorageSnapshotService}). Both are reported because the ledger only
 * keeps the second, and an operator diagnosing an implausible figure needs the
 * first.
 */
export interface StorageSnapshotRow {
  tenantId: string;
  storageClass: StorageClass;
  bytes: number;
  /** Fixed-point decimal string, 6 dp — never a JS number. */
  quantityGb: string;
  provider: 'minio' | 'postgres';
  idempotencyKey: string;
}

/** What one tenant's snapshot produced. */
export interface StorageSnapshotResult {
  tenantId: string;
  /** UTC midnight of the day snapshotted. */
  day: Date;
  /** The rows that were RECORDED. A class holding zero bytes is skipped, so this may be shorter than three. */
  rows: StorageSnapshotRow[];
  /** True when the tenant's media bytes were skipped because it holds them in its own account (DEDICATED topology). */
  mediaSkippedDedicated: boolean;
}

/**
 * The nightly per-(tenant, storage class) GB-day snapshot (TASK-959 §5.2).
 *
 * WHAT IT MEASURES. Not a flow — a LEVEL. Every other ledger row records
 * something that happened during a request; this one records what a tenant was
 * HOLDING when the job ran, on three classes:
 *
 *   - `media`      — per-tenant MinIO objects, `SUM(Media.size)`
 *   - `text`       — the encrypted Postgres columns, `SUM(pg_column_size(...))`
 *   - `claim-check`— offloaded harness payloads, `payloadRef.size` + `resultRef.size`
 *
 * WHY A JOB AND NOT A LIVE AGGREGATE. The other three are interchangeable: a
 * live `SUM` over today's rows answers "what is held now" exactly as well as a
 * stored snapshot does. A PAST day is different — the bytes have since changed,
 * so a day the job did not run can never be recomputed. The job is therefore
 * the only writer of this measure, which is why it ships enabled (see
 * `storage-snapshot.constants.ts`).
 *
 * IDEMPOTENT BY CONSTRUCTION. The key is
 * `storage:<tenantId>:<class>:<YYYY-MM-DD>`, so a re-run for the same day
 * converges on one ledger row at the drainer rather than double-counting —
 * which is what makes a manual backfill of a missed night safe.
 *
 * QUANTITY IS A STRING. `bytes / 1e9` at terabyte scale exceeds what an IEEE
 * double represents exactly at six decimal places, and the ledger column is
 * `Decimal(24,6)`. Every quantity therefore crosses the port as a fixed-point
 * decimal string, never a JS number.
 */
export interface IStorageSnapshotService {
  /**
   * Snapshot ONE tenant for one UTC day.
   *
   * @param day Any instant within the day to snapshot; it is truncated to UTC
   *            midnight. The emitted `occurredAt` is the day's last
   *            millisecond, so the drainer buckets the row into THAT day
   *            rather than the next one.
   */
  snapshotTenant(tenantId: string, day: Date): Promise<StorageSnapshotResult>;

  /** Snapshot every tenant for one UTC day. Resilient to a per-tenant failure — it keeps going and counts only successes. */
  snapshotAll(day: Date): Promise<{ tenants: number; rows: number }>;
}

export const IStorageSnapshotService = Symbol('IStorageSnapshotService');
