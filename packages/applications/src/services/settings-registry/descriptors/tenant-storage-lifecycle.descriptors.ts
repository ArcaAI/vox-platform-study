// TASK-1025 — tenant bucket lifecycle knobs.
//
// G2 (owner decision OD-2): when a tenant is soft-deleted its buckets are
// RETAINED (access cut, objects kept) for a platform-set window, then a
// scheduled job purges them. The window and the job's schedule live here.
//
// All `global-kv`, SYSTEM scope, platform-admin only: data retention after a
// tenant is gone is a platform policy, not something the (deleted) tenant can
// hold an opinion on. `open-to-default`: an unwritten row resolves to the code
// default the consuming service falls back to — the same shape as
// `audit-retention.*`. The window is additionally BOUNDED: the write lane
// refuses an out-of-range value, and the job skips its run (rather than
// purging early) if one ever reaches it another way.

import { SettingDescriptor } from '../registry.types';
import {
  TENANT_STORAGE_PURGE_CRON_KEY,
  TENANT_STORAGE_RETENTION_BOUNDS,
  TENANT_STORAGE_RETENTION_DAYS_KEY,
  TENANT_STORAGE_RETENTION_DEFAULTS,
  isWholeNumberWithin,
} from '../../tenant-bucket/tenant-bucket-lifecycle.constants';

const PLATFORM_KNOB = {
  tier: 'global-kv',
  sensitivity: 'internal',
  maxScope: 'system',
  editableBy: 'all',
  globalOnly: true,
  failMode: 'open-to-default',
  category: 'Storage',
} as const satisfies Partial<SettingDescriptor>;

export const TENANT_STORAGE_LIFECYCLE_SETTINGS: SettingDescriptor[] = [
  {
    ...PLATFORM_KNOB,
    key: TENANT_STORAGE_RETENTION_DAYS_KEY,
    dataType: 'number',
    label: 'Deleted-tenant storage retention (days)',
    description:
      "How long a deleted tenant's storage buckets are kept before they are purged. Deleting a tenant cuts access to its " +
      'buckets at once but keeps every object; restoring the tenant inside this window gives them back. Once the window has ' +
      'passed, the nightly purge removes every object and the buckets themselves, and the data cannot be recovered.',
    default: TENANT_STORAGE_RETENTION_DEFAULTS.retentionDays,
    validate: (value: unknown) =>
      isWholeNumberWithin(value, TENANT_STORAGE_RETENTION_BOUNDS.minDays, TENANT_STORAGE_RETENTION_BOUNDS.maxDays)
        ? undefined
        : `The retention window must be a whole number of days between ${TENANT_STORAGE_RETENTION_BOUNDS.minDays} and ${TENANT_STORAGE_RETENTION_BOUNDS.maxDays}. ` +
          'A shorter window would purge PHI before a mistaken deletion can be undone.',
  },
  {
    ...PLATFORM_KNOB,
    key: TENANT_STORAGE_PURGE_CRON_KEY,
    dataType: 'string',
    label: 'Deleted-tenant storage purge schedule (cron)',
    description:
      'Standard five-field cron expression for the job that purges the buckets of tenants deleted longer ago than the ' +
      'retention window. The scheduler re-reads it on every settings-cache refresh, so a change takes effect without a restart. ' +
      'Re-running it is safe: a bucket already purged is skipped.',
    default: TENANT_STORAGE_RETENTION_DEFAULTS.purgeCron,
  },
];
