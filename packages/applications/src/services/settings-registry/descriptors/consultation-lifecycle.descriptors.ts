// The consultation lifecycle settings: when an untouched consultation closes by itself, whether a
// signed one may be reopened, and how long a stop waits for the final transcript.
//
// ## One auto-close policy
//
// A consultation that nobody touches closes itself. `consultation.autoClose` says when, in one of
// two modes: `idle` closes it once `lastActivityAt` is older than `idleMinutes`; `daily` closes it
// once the tenant's clock passes `dailyAt` ("HH:mm", read in the tenant's appointment-day time zone,
// `consultation.appointmentDay.timeZone`) and the consultation was last touched before that moment.
// It replaces the open, review, session and completion clocks. It is tenant-scoped, resolved
// tenant -> SYSTEM -> this code default (rule 00 section 2), so a tenant that never set it follows
// the platform value, including later changes to it.
//
// The harness clinician gate SLA is derived from `idleMinutes` (see `HarnessPolicyService`).
import { SettingDescriptor } from '../registry.types';
import { CONSULTATION_PIPELINE_CATEGORY } from './consultation-gates.descriptors';

export const CONSULTATION_AUTO_CLOSE_KEY = 'consultation.autoClose';
export const CONSULTATION_REOPEN_ALLOW_CLOSED_COMPLETE_KEY = 'consultation.reopen.allowClosedComplete';
export const CONSULTATION_STOP_FINAL_TRANSCRIPT_TIMEOUT_KEY = 'consultation.stop.finalTranscriptTimeoutSeconds';

export type ConsultationAutoCloseMode = 'idle' | 'daily';

export interface ConsultationAutoClosePolicy {
  mode: ConsultationAutoCloseMode;
  idleMinutes: number;
  /** "HH:mm" in the tenant's appointment-day time zone; required (and only used) in `daily` mode. */
  dailyAt: string | null;
}

/** 12 hours idle. */
export const CONSULTATION_AUTO_CLOSE_DEFAULT: ConsultationAutoClosePolicy = { mode: 'idle', idleMinutes: 720, dailyAt: null };

export const CONSULTATION_AUTO_CLOSE_MIN_IDLE_MINUTES = 15;
export const CONSULTATION_AUTO_CLOSE_MAX_IDLE_MINUTES = 10_080;

export const CONSULTATION_REOPEN_ALLOW_CLOSED_COMPLETE_DEFAULT = false;

export const CONSULTATION_STOP_FINAL_TRANSCRIPT_TIMEOUT_DEFAULT_SECONDS = 30;
const STOP_TIMEOUT_MIN_SECONDS = 5;
const STOP_TIMEOUT_MAX_SECONDS = 120;

const DAILY_AT_PATTERN = /^([01]\d|2[0-3]):[0-5]\d$/;

/** The reason a value is not a usable auto-close policy, or `undefined` when it is one. */
function autoCloseProblem(value: unknown): string | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return 'must be an object { mode, idleMinutes, dailyAt }';
  }
  const { mode, idleMinutes, dailyAt } = value as Record<string, unknown>;
  if (mode !== 'idle' && mode !== 'daily') return "mode must be 'idle' or 'daily'";
  if (
    typeof idleMinutes !== 'number' ||
    !Number.isInteger(idleMinutes) ||
    idleMinutes < CONSULTATION_AUTO_CLOSE_MIN_IDLE_MINUTES ||
    idleMinutes > CONSULTATION_AUTO_CLOSE_MAX_IDLE_MINUTES
  ) {
    return `idleMinutes must be a whole number from ${CONSULTATION_AUTO_CLOSE_MIN_IDLE_MINUTES} to ${CONSULTATION_AUTO_CLOSE_MAX_IDLE_MINUTES} (7 days)`;
  }
  if (dailyAt !== null && dailyAt !== undefined && (typeof dailyAt !== 'string' || !DAILY_AT_PATTERN.test(dailyAt))) {
    return 'dailyAt must be null or a 24-hour "HH:mm" time such as "23:30"';
  }
  if (mode === 'daily' && (dailyAt === null || dailyAt === undefined)) return "dailyAt is required when mode is 'daily'";
  return undefined;
}

/** `open-to-default`: anything that is not a valid policy serves the platform code default. */
export function resolveAutoClosePolicy(value: unknown): ConsultationAutoClosePolicy {
  if (autoCloseProblem(value) !== undefined) return { ...CONSULTATION_AUTO_CLOSE_DEFAULT };
  const { mode, idleMinutes, dailyAt } = value as ConsultationAutoClosePolicy;
  return { mode, idleMinutes, dailyAt: dailyAt ?? null };
}

export const CONSULTATION_LIFECYCLE_SETTINGS: SettingDescriptor[] = [
  {
    key: CONSULTATION_AUTO_CLOSE_KEY,
    tier: 'global-kv',
    dataType: 'json',
    sensitivity: 'internal',
    maxScope: 'tenant',
    editableBy: 'GlobalSetting',
    failMode: 'open-to-default',
    category: CONSULTATION_PIPELINE_CATEGORY,
    label: 'Consultation auto-close',
    description:
      'When an untouched consultation closes by itself. mode "idle" closes it once nothing has happened on it for idleMinutes ' +
      '(15 to 10080). mode "daily" closes it once the tenant clock passes dailyAt ("HH:mm", read in the consultation day time ' +
      'zone) and it was last touched before that moment. An approved consultation closes as complete, any other as incomplete. ' +
      'The clinician gate wait on the harness is derived from idleMinutes. Tenant admins set it for their tenant; the platform ' +
      'value is the default for every tenant that has not. Default: idle after 720 minutes (12 hours).',
    default: CONSULTATION_AUTO_CLOSE_DEFAULT,
    validate: autoCloseProblem,
  },
  {
    key: CONSULTATION_REOPEN_ALLOW_CLOSED_COMPLETE_KEY,
    tier: 'global-kv',
    dataType: 'boolean',
    sensitivity: 'internal',
    maxScope: 'tenant',
    editableBy: 'GlobalSetting',
    failMode: 'open-to-default',
    category: CONSULTATION_PIPELINE_CATEGORY,
    label: 'Allow reopening a completed consultation',
    description:
      'Whether a consultation that was closed as complete (approved) may be reopened. Off by default: an approved record is ' +
      'final. A consultation closed as incomplete can always be reopened.',
    default: CONSULTATION_REOPEN_ALLOW_CLOSED_COMPLETE_DEFAULT,
  },
  {
    key: CONSULTATION_STOP_FINAL_TRANSCRIPT_TIMEOUT_KEY,
    tier: 'global-kv',
    dataType: 'number',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'GlobalSetting',
    globalOnly: true,
    failMode: 'open-to-default',
    category: CONSULTATION_PIPELINE_CATEGORY,
    label: 'Stop: final transcript wait (seconds)',
    description:
      'Seconds a stop waits for the speech service to deliver the final transcript before answering with the transcript still ' +
      'pending. The final transcript is still stored when it arrives later. Whole seconds, 5 to 120. Default 30.',
    default: CONSULTATION_STOP_FINAL_TRANSCRIPT_TIMEOUT_DEFAULT_SECONDS,
    validate: (value: unknown) => {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < STOP_TIMEOUT_MIN_SECONDS || value > STOP_TIMEOUT_MAX_SECONDS) {
        return `must be a whole number of seconds from ${STOP_TIMEOUT_MIN_SECONDS} to ${STOP_TIMEOUT_MAX_SECONDS}`;
      }
    },
  },
];
