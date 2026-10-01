// Tenant checkpoint tunables. Tenant-overridable (a tenant admin owns its own
// retention and lock window), fail-open to the defaults below, and BOUNDED so a
// nonsense value is refused at write time. Tuning knobs only — none of these
// gates a privilege check.

import { SettingDescriptor } from '../registry.types';

export const TENANT_CHECKPOINT_RETENTION_DAYS_KEY = 'tenantCheckpoint.retentionDays';
export const TENANT_CHECKPOINT_MAX_RETAINED_KEY = 'tenantCheckpoint.maxRetained';
export const TENANT_CHECKPOINT_MAX_UPLOAD_GB_KEY = 'tenantCheckpoint.maxUploadSizeGb';
export const TENANT_CHECKPOINT_MAX_LOCK_MINUTES_KEY = 'tenantCheckpoint.maxLockMinutes';

export const TENANT_CHECKPOINT_DEFAULTS = {
  retentionDays: 30,
  maxRetained: 10,
  maxUploadSizeGb: 50,
  maxLockMinutes: 60,
} as const;

const MAX_UPLOAD_GB = 500;
const MAX_LOCK_MINUTES = 240;

function wholeNumber(max?: number) {
  return (value: unknown): string | undefined => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
      return 'Must be a whole number of at least 1.';
    }
    if (max !== undefined && value > max) return `Must not exceed ${max}.`;
    return undefined;
  };
}

const TENANT_KNOB = {
  tier: 'global-kv',
  dataType: 'number',
  sensitivity: 'internal',
  maxScope: 'tenant',
  editableBy: 'GlobalSetting',
  globalOnly: false,
  failMode: 'open-to-default',
  category: 'Checkpoints',
} as const satisfies Partial<SettingDescriptor>;

export const TENANT_CHECKPOINT_SETTINGS: SettingDescriptor[] = [
  {
    ...TENANT_KNOB,
    key: TENANT_CHECKPOINT_RETENTION_DAYS_KEY,
    label: 'Checkpoint retention (days)',
    description: 'How many days a tenant checkpoint is kept before it expires and its archive is deleted.',
    default: TENANT_CHECKPOINT_DEFAULTS.retentionDays,
    validate: wholeNumber(),
  },
  {
    ...TENANT_KNOB,
    key: TENANT_CHECKPOINT_MAX_RETAINED_KEY,
    label: 'Checkpoints retained per tenant',
    description:
      'How many READY checkpoints retention keeps per tenant: the newest this many are kept and older ones are deleted by the retention sweep (the newest is never auto-deleted). Creating a checkpoint is not refused when a tenant is at the limit.',
    default: TENANT_CHECKPOINT_DEFAULTS.maxRetained,
    validate: wholeNumber(),
  },
  {
    ...TENANT_KNOB,
    key: TENANT_CHECKPOINT_MAX_UPLOAD_GB_KEY,
    label: 'Checkpoint upload size limit (GB)',
    description: 'The largest checkpoint archive that may be uploaded for import, in gigabytes (up to 500).',
    default: TENANT_CHECKPOINT_DEFAULTS.maxUploadSizeGb,
    validate: wholeNumber(MAX_UPLOAD_GB),
  },
  {
    ...TENANT_KNOB,
    key: TENANT_CHECKPOINT_MAX_LOCK_MINUTES_KEY,
    label: 'Restore lock limit (minutes)',
    description: 'The longest a tenant stays locked while a restore runs, in minutes (up to 240).',
    default: TENANT_CHECKPOINT_DEFAULTS.maxLockMinutes,
    validate: wholeNumber(MAX_LOCK_MINUTES),
  },
];
