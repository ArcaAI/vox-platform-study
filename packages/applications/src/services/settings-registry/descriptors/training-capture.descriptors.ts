// TASK-972 Lane 2 (OD-4) — the TENANT half of the training-capture gate.
//
// ## Why the key exists
//
// `GateEditExemplar` mines a PHI-redacted `(AI draft, signed note)` pair from every clinician
// sign-off and exports it as a fine-tuning corpus. §2.4 established that the pipeline contains
// no consent check of any kind — zero `ConsentGrant` references — which was tolerable only while
// it had no live writer. This ticket gives it one, and a high-volume one, so the tenant gets a
// switch: the clinician's own three-state toggle (`trainingCapture:enabled`, a `UserSettings`
// row) AND this, resolved as `effective = tenantEnabled && (doctorToggle ?? true)`.
//
// ## Why it defaults to ENABLED, unlike a kill-switch
//
// Rule 09 says a kill-switch must default OFF, and this is deliberately NOT declared as one.
// Mining runs UNCONDITIONALLY on the current branch: defaulting this key to `false` would
// silently switch off a feature that ships enabled, which is a regression wearing a safety
// costume. The key SWITCHES OFF a capture the platform already performs, so `open-to-default`
// with `default: true` is the only setting under which an unconfigured deployment behaves
// exactly as it does today.
//
// ## Why it is tenant-overridable rather than `globalOnly`
//
// Rule 00 §2: resolution is tenant → platform default. Whether a tenant's clinical text may be
// retained for model training is a decision that tenant owns — it is closer to a BAA term than
// to a platform tuning knob — so `maxScope: 'tenant'` and no `globalOnly`. The SYSTEM row is the
// FALLBACK for a tenant with no opinion, never a value that wins over the tenant's own.
//
// ## What this gate does NOT do
//
// It suppresses CAPTURE and nothing else. An opted-out clinician still signs, still reaches
// SIGNED and still closes: a clinical action is never failed for a training-data reason. The
// enforcement points are `GateEditMiningQueue.enqueue` (so nothing is queued) and
// `GateEditMiningProcessor.process` (so a toggle flipped between enqueue and drain is still
// honoured, before anything is persisted).

import { SettingDescriptor } from '../registry.types';

/** Whether this tenant's signed notes may be captured as supervised training exemplars. */
export const TRAINING_CAPTURE_ENABLED_KEY = 'consultation.feedback.trainingCapture.enabled';

/** The code default — ENABLED, i.e. byte-identical to the pre-ticket behaviour. */
export const TRAINING_CAPTURE_ENABLED_DEFAULT = true;

export const TRAINING_CAPTURE_SETTINGS: SettingDescriptor[] = [
  {
    key: TRAINING_CAPTURE_ENABLED_KEY,
    tier: 'global-kv',
    dataType: 'boolean',
    sensitivity: 'internal',
    maxScope: 'tenant',
    editableBy: 'GlobalSetting',
    // NOT `killSwitch: true` — see the header. A kill-switch must default OFF, and this must
    // default ON or it retires a shipped feature on the day it is registered.
    failMode: 'open-to-default',
    category: 'Consultation Feedback',
    label: 'Capture clinician edits as training exemplars',
    description:
      'When enabled, the PHI-redacted pair of (AI draft, clinician-signed note) from each sign-off is retained as a supervised ' +
      'training exemplar. A clinician may opt out individually; this is the tenant-wide gate above that, and switching it off ' +
      'stops capture only — signing and closing a consultation are unaffected.',
    default: TRAINING_CAPTURE_ENABLED_DEFAULT,
  },
];
