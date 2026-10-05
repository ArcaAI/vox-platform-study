// Consultation attachments and feedback — operational limits and the feedback reason-code list.
//
// Every key is `global-kv` and `open-to-default`: a missing row degrades to the default below,
// never an outage. Tenant-scope keys follow the tenant → SYSTEM cascade; the rest are platform
// tuning (SYSTEM only, platform admin). The presigned-upload size ceilings are NOT redeclared
// here — they reuse `media.upload.maxAttachmentSizeMb` / `maxAudioSizeMb` and
// `stt.batch.maxFileSizeMb`.

import { SettingDescriptor } from '../registry.types';

export const CONSULTATION_ATTACHMENTS_FEEDBACK_CATEGORY = 'Consultation Attachments & Feedback';

export interface FeedbackReasonCode {
  code: string;
  label: string;
  appliesTo?: string[];
}

export const FEEDBACK_REASON_CODES_KEY = 'consultation.feedback.reasonCodes';
export const FEEDBACK_ROLLUP_CRON_KEY = 'consultation.feedback.rollupCron';
export const FEEDBACK_ROLLUP_LOOKBACK_DAYS_KEY = 'consultation.feedback.rollupLookbackDays';

/** The platform list a tenant sees until it writes its own (a tenant value replaces the list). */
export const FEEDBACK_REASON_CODES_DEFAULT: readonly FeedbackReasonCode[] = [
  { code: 'missing_information', label: 'Missing information' },
  { code: 'wrong_medication_or_dose', label: 'Wrong medication or dose' },
  { code: 'wrong_patient_detail', label: 'Wrong patient detail' },
  { code: 'made_something_up', label: 'Made something up' },
  { code: 'wrong_section', label: 'Placed in the wrong section' },
  { code: 'too_long', label: 'Too long' },
  { code: 'wrong_language', label: 'Wrong language' },
];

const REASON_CODE_PATTERN = /^[a-z][a-z0-9_]{1,47}$/;
const MAX_REASON_CODES = 32;
const MAX_LABEL_CHARS = 80;

/** Reports every bad entry, not just the first. */
export function validateFeedbackReasonCodes(value: unknown): string | void {
  if (!Array.isArray(value)) return `${FEEDBACK_REASON_CODES_KEY} must be a JSON array of { code, label, appliesTo? }.`;
  if (value.length < 1 || value.length > MAX_REASON_CODES) {
    return `${FEEDBACK_REASON_CODES_KEY} must hold between 1 and ${MAX_REASON_CODES} reasons.`;
  }
  const problems: string[] = [];
  const seen = new Set<string>();
  value.forEach((entry, i) => {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      problems.push(`entry ${i} must be an object`);
      return;
    }
    const { code, label, appliesTo } = entry as Record<string, unknown>;
    if (typeof code !== 'string' || !REASON_CODE_PATTERN.test(code)) {
      problems.push(`entry ${i} code must match ${REASON_CODE_PATTERN.source}`);
    } else if (seen.has(code)) {
      problems.push(`entry ${i} code "${code}" is duplicated`);
    } else {
      seen.add(code);
    }
    if (typeof label !== 'string' || label.length < 1 || label.length > MAX_LABEL_CHARS) {
      problems.push(`entry ${i} label must be 1-${MAX_LABEL_CHARS} characters`);
    }
    if (appliesTo !== undefined && (!Array.isArray(appliesTo) || appliesTo.some((a) => typeof a !== 'string'))) {
      problems.push(`entry ${i} appliesTo must be an array of strings`);
    }
  });
  if (problems.length > 0) return `${FEEDBACK_REASON_CODES_KEY} is invalid — ${problems.join(' | ')}.`;
}

function intBetween(label: string, min: number, max: number) {
  return (value: unknown): string | void => {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < min || value > max) {
      return `${label} must be a whole number between ${min} and ${max}.`;
    }
  };
}

function cronExpression(label: string) {
  return (value: unknown): string | void => {
    if (typeof value !== 'string' || value.trim().split(/\s+/).length !== 5) {
      return `${label} must be a five-field cron expression.`;
    }
  };
}

const BASE = {
  tier: 'global-kv',
  sensitivity: 'internal',
  editableBy: 'GlobalSetting',
  failMode: 'open-to-default',
  category: CONSULTATION_ATTACHMENTS_FEEDBACK_CATEGORY,
} as const;

const TENANT = { ...BASE, maxScope: 'tenant' } as const;
const PLATFORM = { ...BASE, maxScope: 'system', globalOnly: true } as const;

export const CONSULTATION_ATTACHMENTS_FEEDBACK_SETTINGS: SettingDescriptor[] = [
  {
    ...TENANT,
    key: 'consultation.attachments.multipartMaxMb',
    dataType: 'number',
    label: 'Attachment multipart upload ceiling (MB)',
    description: 'Largest attachment accepted on the direct multipart route; anything larger must use the presigned-upload flow. Default 10.',
    default: 10,
    validate: intBetween('Multipart ceiling (MB)', 1, 100),
  },
  {
    ...PLATFORM,
    key: 'consultation.attachments.uploadUrlTtlSeconds',
    dataType: 'number',
    label: 'Attachment upload URL lifetime (seconds)',
    description: 'How long a presigned attachment upload URL stays valid after the intent is created. 60 to 3600; default 600.',
    default: 600,
    validate: intBetween('Upload URL lifetime (seconds)', 60, 3600),
  },
  {
    ...PLATFORM,
    key: 'consultation.attachments.intentTtlHours',
    dataType: 'number',
    label: 'Attachment upload intent lifetime (hours)',
    description: 'An upload intent that is never completed within this window is expired by the reaper and its object removed. Default 24.',
    default: 24,
    validate: intBetween('Intent lifetime (hours)', 1, 168),
  },
  {
    ...PLATFORM,
    key: 'consultation.attachments.reapCron',
    dataType: 'string',
    label: 'Attachment reaper schedule',
    description: 'Cron expression for the job that expires stale upload intents. Default every 15 minutes.',
    default: '*/15 * * * *',
    validate: cronExpression('Reaper schedule'),
  },
  {
    ...PLATFORM,
    key: 'consultation.attachments.inlineVerifyMaxMb',
    dataType: 'number',
    label: 'Attachment inline verification ceiling (MB)',
    description:
      'Uploads up to this size are verified (size, checksum, content sniff) inside the completion request; larger ones are verified asynchronously. Default 32.',
    default: 32,
    validate: intBetween('Inline verification ceiling (MB)', 1, 256),
  },
  {
    ...TENANT,
    key: FEEDBACK_REASON_CODES_KEY,
    dataType: 'json',
    label: 'Feedback reason codes',
    description:
      'The reasons a clinician can attach to a thumbs-down, as a list of { code, label, appliesTo? }. A tenant value REPLACES the platform list (1-32 entries, unique codes of lowercase letters, digits and underscores, labels up to 80 characters). Absent means the platform list applies.',
    default: FEEDBACK_REASON_CODES_DEFAULT,
    validate: validateFeedbackReasonCodes,
  },
  {
    ...PLATFORM,
    key: 'consultation.feedback.commentMaxChars',
    dataType: 'number',
    label: 'Feedback comment length limit',
    description: 'Maximum characters in a feedback comment; longer comments are refused with 413. Default 4000.',
    default: 4000,
    validate: intBetween('Comment length limit', 1, 20000),
  },
  {
    ...PLATFORM,
    key: 'consultation.feedback.maxMediaPerFeedback',
    dataType: 'number',
    label: 'Feedback media attachments limit',
    description: 'Maximum media attachments on one piece of feedback. 0 disables feedback media. Default 3.',
    default: 3,
    validate: intBetween('Media attachments per feedback', 0, 10),
  },
  {
    ...PLATFORM,
    key: FEEDBACK_ROLLUP_CRON_KEY,
    dataType: 'string',
    label: 'Feedback rollup schedule',
    description: 'Cron expression for the job that rolls feedback events up into daily aggregates. Default 01:30 daily.',
    default: '30 1 * * *',
    validate: cronExpression('Rollup schedule'),
  },
  {
    ...PLATFORM,
    key: FEEDBACK_ROLLUP_LOOKBACK_DAYS_KEY,
    dataType: 'number',
    label: 'Feedback rollup lookback (days)',
    description: 'How many trailing days each rollup run recomputes, so late-arriving feedback lands in the right day. Default 2.',
    default: 2,
    validate: intBetween('Rollup lookback (days)', 1, 30),
  },
];
