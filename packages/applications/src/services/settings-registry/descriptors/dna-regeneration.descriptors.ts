// TASK-1034 (R1, owner OD-2/OD-3) — the weekly, feedback-gated DNA writing-style regeneration.
//
// Every key is a platform default (SYSTEM row → code default) that a tenant admin may override for
// their own tenant (`maxScope: 'tenant'`). The scheduler evaluates each tenant's own `cron` in that
// tenant's `consultation.appointmentDay.timeZone`, and regenerates a clinician only when at least
// `min-new-samples` unconsumed memory samples (edits, sign-offs, ingested history) arrived since
// their latest report. All are tuning knobs, so an absent value falls back to the default.
import { CronTime } from 'cron';
import { SettingDescriptor } from '../registry.types';

export const DNA_REGEN_CATEGORY = 'DNA Writing Style';

export const DNA_REGEN_KEYS = {
  enabled: 'dna-regen.enabled',
  cron: 'dna-regen.cron',
  minNewSamples: 'dna-regen.min-new-samples',
  maxSamples: 'dna-regen.max-samples',
  maxContextChars: 'dna-regen.max-context-chars',
  jobDelayMs: 'dna-regen.job-delay-ms',
} as const;

export const DNA_REGEN_DEFAULTS = {
  enabled: true,
  cron: '0 2 * * 1',
  minNewSamples: 3,
  maxSamples: 50,
  maxContextChars: 100_000,
  jobDelayMs: 5000,
} as const;

/** `true` when `value` is a cron expression the scheduler's own `cron` library accepts. */
export function isValidCron(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim().length === 0) return false;
  try {
    new CronTime(value);
    return true;
  } catch {
    return false;
  }
}

function positiveInteger(min: number) {
  return (value: unknown): string | undefined => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min) return `must be an integer ≥ ${min}`;
    return undefined;
  };
}

const common = {
  tier: 'global-kv',
  sensitivity: 'internal',
  maxScope: 'tenant',
  editableBy: 'GlobalSetting',
  failMode: 'open-to-default',
  category: DNA_REGEN_CATEGORY,
} as const;

export const DNA_REGEN_SETTINGS: SettingDescriptor[] = [
  {
    ...common,
    key: DNA_REGEN_KEYS.enabled,
    dataType: 'boolean',
    label: 'Weekly DNA regeneration enabled',
    description:
      'Rebuilds a clinician`s DNA writing-style profile on the schedule below when enough new memory (edits, sign-offs, ingested notes) has arrived since their last profile. Default on.',
    default: DNA_REGEN_DEFAULTS.enabled,
  },
  {
    ...common,
    key: DNA_REGEN_KEYS.cron,
    dataType: 'string',
    label: 'DNA regeneration schedule',
    description: 'Cron expression, read in the tenant`s consultation time zone. Default Monday 02:00 (`0 2 * * 1`).',
    default: DNA_REGEN_DEFAULTS.cron,
    validate: (value: unknown) => (isValidCron(value) ? undefined : 'must be a valid cron expression, for example 0 2 * * 1'),
  },
  {
    ...common,
    key: DNA_REGEN_KEYS.minNewSamples,
    dataType: 'number',
    label: 'Minimum new memory samples',
    description:
      'A clinician is regenerated only when at least this many new, unconsumed memory samples arrived since their latest profile. Default 3.',
    default: DNA_REGEN_DEFAULTS.minNewSamples,
    validate: positiveInteger(1),
  },
  {
    ...common,
    key: DNA_REGEN_KEYS.maxSamples,
    dataType: 'number',
    label: 'DNA corpus max samples',
    description: 'Upper bound on approved summaries and memory samples read into one DNA analysis. Default 50.',
    default: DNA_REGEN_DEFAULTS.maxSamples,
    validate: positiveInteger(1),
  },
  {
    ...common,
    key: DNA_REGEN_KEYS.maxContextChars,
    dataType: 'number',
    label: 'DNA corpus max characters',
    description: 'Upper bound on the characters sent to the DNA analyst in one analysis. Default 100000.',
    default: DNA_REGEN_DEFAULTS.maxContextChars,
    validate: positiveInteger(1000),
  },
  {
    ...common,
    key: DNA_REGEN_KEYS.jobDelayMs,
    dataType: 'number',
    label: 'DNA regeneration job stagger (ms)',
    description: 'Delay between the regeneration jobs one scheduled run queues, so a large tenant does not start every analysis at once.',
    default: DNA_REGEN_DEFAULTS.jobDelayMs,
    validate: positiveInteger(0),
  },
];
