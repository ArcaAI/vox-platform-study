// TASK-959 §5.2 — the nightly storage snapshot's schedule and master switch.
//
// ## Why these two keys are not in `metering.descriptors.ts`
//
// They would fit that file's shape exactly — `global-kv`, `globalOnly`,
// `maxScope: 'system'`, Platform Operations — but they do NOT fit its
// SEMANTICS, and the difference is the whole reason this job exists.
//
// Every other sweep in that file persists something a live query could
// recompute on demand: `metering.reconcile.*` warms `TenantUsageMeter` from an
// aggregate `MeteringService.getCurrentUsage` runs anyway, and
// `metering.outbox.prune.*` deletes rows whose durable record is the
// `AiUsageEvent` the drainer already wrote. Both default OFF precisely because
// nothing is lost while they are off.
//
// This one measures a LEVEL, not a flow. The bytes a tenant held on
// 2026-09-12 stop being observable on 2026-09-13 — there is no table to read
// them back from and no query that can reconstruct them. A night the job does
// not run is a day that is permanently unbilled, so the switch defaults ON,
// and it is filed here so nobody reading the OFF-by-default family above
// concludes this one may safely join them.
//
// ## Why `enabled` is not a `killSwitch`
//
// The registry enforces a default-OFF invariant on `killSwitch: true`
// (`SettingsRegistry.killSwitches`), which is correct for a flag that disables
// an ENFORCEMENT path: failing safe means not enforcing. This flag disables a
// MEASUREMENT, where the safe direction is the opposite one. Same polarity and
// the same reasoning as `metering.outbox.drain.enabled`, which is likewise a
// protection-enable flag rather than a kill-switch.

import { SettingDescriptor } from '../registry.types';
import { STORAGE_SNAPSHOT_CRON_KEY, STORAGE_SNAPSHOT_DEFAULTS, STORAGE_SNAPSHOT_ENABLED_KEY } from '../../storage-snapshot/storage-snapshot.constants';

export const METERING_STORAGE_SETTINGS: SettingDescriptor[] = [
  {
    key: STORAGE_SNAPSHOT_ENABLED_KEY,
    tier: 'global-kv',
    dataType: 'boolean',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'all',
    globalOnly: true,
    failMode: 'open-to-default',
    category: 'Platform Operations',
    label: 'Storage snapshot sweep enabled',
    description:
      'Enables the nightly job that records what each tenant is STORING as one STORAGE_GB_DAY ledger row per (tenant, storage class) for the UTC day just closed — media objects, the encrypted Postgres columns, and offloaded harness claim-check payloads. Defaults ON, unlike the two metering sweeps beside it: those persist figures a live aggregate can always recompute, while a storage level is only observable on the day it is taken. A night this job does not run is a day that can never be billed, so switching it off is a deliberate, temporary act.',
    default: STORAGE_SNAPSHOT_DEFAULTS.enabled,
  },
  {
    key: STORAGE_SNAPSHOT_CRON_KEY,
    tier: 'global-kv',
    dataType: 'string',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'all',
    globalOnly: true,
    failMode: 'open-to-default',
    category: 'Platform Operations',
    label: 'Storage snapshot sweep cron',
    description:
      'Cron schedule for the nightly storage snapshot. The default runs at 02:15 UTC — past midnight so the day being measured is closed, and off the hour so it does not contend with the platform’s other sweeps. Re-running it for a day already snapshotted is safe: the ledger key is storage:<tenantId>:<class>:<YYYY-MM-DD>, so a repeat converges on the same row rather than double-counting.',
    default: STORAGE_SNAPSHOT_DEFAULTS.cron,
  },
];
