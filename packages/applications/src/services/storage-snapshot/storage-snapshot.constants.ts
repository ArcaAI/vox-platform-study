/**
 * Nightly storage-snapshot constants (TASK-959 §5.2).
 *
 * The job emits one `STORAGE_GB_DAY` ledger row per (tenant, storage class)
 * for the UTC day that just closed. Unlike `metering.reconcile.*` — whose
 * snapshots only WARM a table the live aggregate can always recompute — this
 * job is the ONLY writer of its measure: storage held on a past day cannot be
 * reconstructed after the fact, because the bytes have since changed. A day
 * the job did not run is a day that is permanently unbilled.
 *
 * That is why it defaults ON while its two siblings default OFF, and it is not
 * a `killSwitch` descriptor (whose registry invariant is a default-OFF flag):
 * turning it off removes a measurement, it does not disable an enforcement
 * path. Same polarity, and the same reasoning, as `metering.outbox.drain.enabled`.
 */
export const STORAGE_SNAPSHOT_JOB_NAME = 'tenant-storage-snapshot';

export const STORAGE_SNAPSHOT_ENABLED_KEY = 'metering.storageSnapshot.enabled';
export const STORAGE_SNAPSHOT_CRON_KEY = 'metering.storageSnapshot.cron';

export const STORAGE_SNAPSHOT_DEFAULTS = {
  /** ON — a missed night is an unrecoverable gap, not a warm-cache miss. */
  enabled: true,
  /**
   * 02:15 UTC daily. Past midnight so the day being snapshotted is closed, and
   * offset from the hour so it does not contend with every other `0 * * * *`
   * sweep in the platform.
   */
  cron: '15 2 * * *',
} as const;

/** Bytes per gigabyte. The unit is the GIGABYTE-day: a byte-day is unpriceable at integer-micro precision (W0). */
export const BYTES_PER_GIGABYTE = 1_000_000_000;

/** `Decimal(24,6)` on the ledger — six fractional digits is 1 KB of resolution per GB-day. */
export const STORAGE_GB_DECIMAL_PLACES = 6;
