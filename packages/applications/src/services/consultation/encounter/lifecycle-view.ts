import type { EncounterResponse } from '../consultation/dto/encounter.response';
import type { ConsultationApprovalResponse } from '../consultation/dto/consultation.response';

/** The tenant's auto-close policy (`{ mode, idleMinutes, dailyAt }`); declared by the lifecycle settings descriptors. */
export const CONSULTATION_AUTO_CLOSE_SETTING_KEY = 'consultation.autoClose';

/** Whether a CLOSED_COMPLETE consultation may be reopened in this tenant; declared by the lifecycle settings descriptors. */
export const CONSULTATION_REOPEN_ALLOW_CLOSED_COMPLETE_SETTING_KEY = 'consultation.reopen.allowClosedComplete';

/** The resolved auto-close policy. `idle` closes `idleMinutes` after the last activity; `daily` closes at `dailyAt` (HH:mm) in the tenant's appointment-day time zone. */
export interface AutoClosePolicy {
  mode: 'idle' | 'daily';
  idleMinutes: number | null;
  dailyAt: string | null;
}

/**
 * The episode facts a `ConsultationResponse` carries beyond the row itself. Loaded once per
 * single-consultation answer; list answers go without it (see `ConsultationDtoMapper.toResponse`).
 */
export interface ConsultationLifecycleView {
  encounters: EncounterResponse[];
  approval: ConsultationApprovalResponse | null;
  autoCloseAt: Date | null;
  allowClosedCompleteReopen: boolean;
}

const DAILY_AT = /^([01]\d|2[0-3]):([0-5]\d)$/;

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** The policy, or `null` when the value is absent or malformed (no deadline is reported then). */
export function readAutoClosePolicy(value: unknown): AutoClosePolicy | null {
  if (!isPlainObject(value)) return null;
  const mode = value.mode;
  if (mode !== 'idle' && mode !== 'daily') return null;
  const idleMinutes = typeof value.idleMinutes === 'number' && Number.isFinite(value.idleMinutes) && value.idleMinutes > 0 ? value.idleMinutes : null;
  const dailyAt = typeof value.dailyAt === 'string' && DAILY_AT.test(value.dailyAt) ? value.dailyAt : null;
  return { mode, idleMinutes, dailyAt };
}

/** `instant`'s wall-clock offset from UTC in `timeZone`, in ms (local − UTC). */
function zoneOffsetMs(instant: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hourCycle: 'h23',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  }).formatToParts(new Date(instant));
  const get = (type: string) => Number(parts.find((p) => p.type === type)?.value);
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'));
  return asUtc - Math.floor(instant / 1000) * 1000;
}

/** The UTC instant of the wall-clock time `y-m-d hh:mm` in `timeZone`. */
function zonedWallClockToUtc(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute);
  const first = guess - zoneOffsetMs(guess, timeZone);
  const second = guess - zoneOffsetMs(first, timeZone);
  return second;
}

/**
 * When the policy will close a consultation that sees no further activity, or `null` when the
 * policy does not resolve. Idle: `lastActivityAt + idleMinutes`. Daily: the next `dailyAt` after
 * `now` in `timeZone`.
 */
export function computeAutoCloseAt(policy: AutoClosePolicy | null, at: { lastActivityAt: Date; now: Date; timeZone: string }): Date | null {
  if (!policy) return null;
  if (policy.mode === 'idle') {
    return policy.idleMinutes === null ? null : new Date(at.lastActivityAt.getTime() + policy.idleMinutes * 60_000);
  }
  if (!policy.dailyAt) return null;
  const [hour, minute] = policy.dailyAt.split(':').map(Number);
  const today = new Intl.DateTimeFormat('en-CA', { timeZone: at.timeZone, year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(at.now)
    .split('-')
    .map(Number);
  const [year, month, day] = today;
  let candidate = zonedWallClockToUtc(year, month, day, hour, minute, at.timeZone);
  if (candidate <= at.now.getTime()) {
    const tomorrow = new Date(Date.UTC(year, month - 1, day + 1));
    candidate = zonedWallClockToUtc(tomorrow.getUTCFullYear(), tomorrow.getUTCMonth() + 1, tomorrow.getUTCDate(), hour, minute, at.timeZone);
  }
  return new Date(candidate);
}
