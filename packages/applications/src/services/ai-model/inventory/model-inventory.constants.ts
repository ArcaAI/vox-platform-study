/**
 * TASK-890 J1 MINOR-7 — where the LAST inventory report lives.
 *
 * The report used to exist only in the browser tab that produced it, so the
 * "In bucket, not registered" drawer was disabled on a fresh load and an
 * operator had to re-run a full bucket sweep to see a list the platform had
 * already computed. One Redis key, read by `GET admin/ai-models/inventory`.
 *
 * Its own module for the reason `inference-readiness.constants.ts` is one: a
 * constant must be importable without pulling a Nest provider graph behind it.
 */

/** The ONE key holding the last `ModelInventoryReport`, as JSON. */
export const MODEL_INVENTORY_REPORT_KEY = 'model:inventory:lastReport';

/**
 * How long a stored report stays readable: 25 hours, one hour past the default
 * hourly cron (`modelRegistry.inventory.cron`). Long enough that the next run
 * always overwrites a live entry, short enough that a platform whose sweep has
 * been switched off stops presenting a day-old measurement as current. The
 * report carries its own `checkedAt`, so the console can say how old it is.
 */
export const MODEL_INVENTORY_REPORT_TTL_SECONDS = 25 * 60 * 60;
