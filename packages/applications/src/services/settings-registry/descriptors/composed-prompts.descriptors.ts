// Composed-prompt incident records (OD-9): how long the encrypted copy of the exact system + user
// messages an LLM call was sent is kept. Tenant-overridable (a tenant owns its own PHI retention),
// fail-open to the default, and BOUNDED so a nonsense value is refused at write time. A tuning
// knob only — it gates no privilege check.

import { SettingDescriptor } from '../registry.types';

export const COMPOSED_PROMPTS_RETENTION_DAYS_KEY = 'composedPrompts.retentionDays';

export const COMPOSED_PROMPTS_DEFAULTS = {
  retentionDays: 30,
} as const;

/** The longest a composed prompt may be kept — a year of PHI copies is already generous. */
const MAX_RETENTION_DAYS = 365;

export const COMPOSED_PROMPTS_SETTINGS: SettingDescriptor[] = [
  {
    key: COMPOSED_PROMPTS_RETENTION_DAYS_KEY,
    tier: 'global-kv',
    dataType: 'number',
    sensitivity: 'internal',
    maxScope: 'tenant',
    editableBy: 'GlobalSetting',
    globalOnly: false,
    failMode: 'open-to-default',
    category: 'Data retention',
    label: 'Composed prompt retention (days)',
    description:
      'How many days the encrypted copy of each composed LLM prompt (system + user messages, kept for incident reconstruction) is retained before the daily purge deletes it.',
    default: COMPOSED_PROMPTS_DEFAULTS.retentionDays,
    validate: (value: unknown): string | undefined => {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) return 'Must be a whole number of at least 1.';
      if (value > MAX_RETENTION_DAYS) return `Must not exceed ${MAX_RETENTION_DAYS}.`;
      return undefined;
    },
  },
];
