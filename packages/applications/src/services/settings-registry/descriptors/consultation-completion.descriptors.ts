// TASK-1001 wave 6 (owner decision 2026-09-23) — the consultation COMPLETION TIMEOUT.
//
// ## What it measures
//
// A consultation is READY TO COMPLETE once the clinician has stopped recording AND the final note
// has been generated. From that moment it waits for the clinician's approval (in ALaaS: Save or
// Submit on the final summary, edited or as generated). With no approval inside this many minutes
// the session is closed unsigned (`CLOSED_INCOMPLETE`). Nothing is lost: a later approval still
// signs it (`CLOSED_INCOMPLETE → SIGNED`), and the clinician may resume recording
// (`CLOSED_INCOMPLETE → RECORDING`) — the next stop re-finalises the note over the whole visit and
// starts a fresh window.
//
// ## Why a setting, and why tenant scope
//
// Owner: "it must be in the settings, where tenant admin can see all tenant settings and where the
// platform admin can see the platform and default settings for tenants to fall back". So it is a
// registry descriptor (rendered on the Settings screen for both audiences), `maxScope: 'tenant'`,
// resolved tenant → SYSTEM → this code default like every other configuration (rule 00 §2). A tenant
// that never set it follows the platform value, including later changes to it.
//
// ## Who enforces it
//
// The harness clinician gate (`HarnessDocWorkflow`) — a durable Temporal timer, exact to the
// second, where the gateway's sweeps run on a cron. The harness fetches ONE document per run (the
// effective harness policy), so `HarnessPolicyService.getEffectivePolicy` derives the gate from
// this value (`gateSlaSeconds = minutes × 60`, `gateMaxEscalations = 1`), exactly as it already
// serves `agentic.context.tokenBudget.perRun`. `HarnessPolicy.gateSlaSeconds` is superseded as the
// source of the gate SLA; the console shows it read-only and points here.
import { SettingDescriptor } from '../registry.types';
import { CONSULTATION_PIPELINE_CATEGORY } from './consultation-gates.descriptors';

export const CONSULTATION_COMPLETION_TIMEOUT_MINUTES_KEY = 'consultation.session.completionTimeoutMinutes';

/** The platform's code default: 5 minutes. A platform admin changes the effective value in Settings. */
export const CONSULTATION_COMPLETION_TIMEOUT_MINUTES_DEFAULT = 5;

/** One week — a window longer than this is a misconfiguration, not a completion timeout. */
const MAX_MINUTES = 10_080;

export const CONSULTATION_COMPLETION_TIMEOUT_SETTINGS: SettingDescriptor[] = [
  {
    key: CONSULTATION_COMPLETION_TIMEOUT_MINUTES_KEY,
    tier: 'global-kv',
    dataType: 'number',
    sensitivity: 'internal',
    maxScope: 'tenant',
    editableBy: 'GlobalSetting',
    failMode: 'open-to-default',
    category: CONSULTATION_PIPELINE_CATEGORY,
    label: 'Consultation completion timeout (minutes)',
    description:
      'Minutes a consultation waits for the clinician to approve the final note (Save / Submit) once recording has stopped and ' +
      'the final note has been generated. With no approval by then the session is closed unsigned (CLOSED_INCOMPLETE). A later ' +
      'approval still signs it, and the clinician may resume recording; every resumed recording restarts the window when it ' +
      'stops. Tenant admins set it for their tenant; the platform value is the default for every tenant that has not. Whole ' +
      'minutes, 1 to 10080. Default 5.',
    default: CONSULTATION_COMPLETION_TIMEOUT_MINUTES_DEFAULT,
    validate: (value: unknown) => {
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > MAX_MINUTES) {
        return `must be a whole number of minutes from 1 to ${MAX_MINUTES} (7 days)`;
      }
    },
  },
];
