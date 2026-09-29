// TASK-1020 (BP-5, owner answer OD-8, 2026-09-29) — the time zone a consultation's DAY is read in.
//
// ## What it decides
//
// `POST /consultations/open` defaults `appointmentDate` to "today" when the caller sends none, and
// "today" is also what the legacy open key `(tenant, patient, appointmentDate, doctor)` and the
// same-day parent derivation (OD-4) compare on. It used to be the server's UTC date, so an IST visit
// before 05:30 landed on the PREVIOUS day and a morning and afternoon visit could fall on two
// different "days". A day is the tenant's local day: `today` is computed in this IANA zone. A
// caller-supplied `appointmentDate` still wins — this only fills the gap.
//
// ## Why a setting, and why tenant scope
//
// The zone is configuration a tenant owns (rule 00 §2): resolved tenant → SYSTEM → this code
// default, `maxScope: 'tenant'`, like the completion timeout beside it. The platform default is
// `UTC` — byte-identical to the behaviour before this ticket — and the ArcaAI tenant's row is
// `Asia/Kolkata`. `failMode: 'open-to-default'`: a day boundary is a tuning knob, not a selection,
// so an absent value falls back to UTC rather than refusing to open a consultation.
import { SettingDescriptor } from '../registry.types';
import { CONSULTATION_PIPELINE_CATEGORY } from './consultation-gates.descriptors';

export const CONSULTATION_APPOINTMENT_DAY_TIME_ZONE_KEY = 'consultation.appointmentDay.timeZone';

/** The platform's code default — the UTC day, exactly the pre-TASK-1020 behaviour. */
export const CONSULTATION_APPOINTMENT_DAY_TIME_ZONE_DEFAULT = 'UTC';

/**
 * `true` when `value` is a time zone this runtime's ICU resolves (an IANA name such as
 * `Asia/Kolkata`, or `UTC`). `Intl.DateTimeFormat` throws a `RangeError` for anything else, which
 * is the one authority the consumer itself uses — validating against a hand-kept list would admit
 * a zone the formatter then refuses.
 */
export function isValidTimeZone(value: unknown): value is string {
  if (typeof value !== 'string' || value.trim().length === 0) return false;
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone: value });
    return true;
  } catch {
    return false;
  }
}

export const CONSULTATION_APPOINTMENT_DAY_SETTINGS: SettingDescriptor[] = [
  {
    key: CONSULTATION_APPOINTMENT_DAY_TIME_ZONE_KEY,
    tier: 'global-kv',
    dataType: 'string',
    sensitivity: 'internal',
    maxScope: 'tenant',
    editableBy: 'GlobalSetting',
    failMode: 'open-to-default',
    category: CONSULTATION_PIPELINE_CATEGORY,
    label: 'Consultation day time zone',
    description:
      'The IANA time zone (for example Asia/Kolkata) a consultation day is read in. When a consultation is opened without an ' +
      'appointment date, it is dated today in this zone, and same-day visits of a patient are matched and chained on that ' +
      'date. A date the caller sends always wins. Tenant admins set it for their tenant; the platform value is the default ' +
      'for every tenant that has not. Default UTC.',
    default: CONSULTATION_APPOINTMENT_DAY_TIME_ZONE_DEFAULT,
    validate: (value: unknown) => {
      if (!isValidTimeZone(value)) {
        return 'must be an IANA time zone name, for example Asia/Kolkata or UTC';
      }
    },
  },
];
