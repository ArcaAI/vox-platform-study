// TASK-1063 item 4 — platform switch for gate-edit exemplar CAPTURE.
//
// The fail-closed PHI heuristic dropped every note in the TASK-1062 acceptance run, so the
// capture produced nothing useful while still redacting (and persisting) clinical text. Capture
// is therefore OFF until the owner turns it on: with the key false, `GateEditMiningService`
// writes no `GateEditExemplar` row (gate mining or feedback) and makes no redaction call.
// Reading existing exemplars and the SME / fine-tune / golden-case exports are unaffected.
//
// Unlike `consultation.feedback.trainingCapture.enabled` (tenant consent, default ON), this is a
// platform-wide capability switch: SYSTEM tier only, default OFF, `open-to-default`.

import { SettingDescriptor } from '../registry.types';

export const GATE_EDIT_EXEMPLAR_CAPTURE_ENABLED_KEY = 'gateEdit.exemplarCapture.enabled';

/** Code default — capture OFF. */
export const GATE_EDIT_EXEMPLAR_CAPTURE_ENABLED_DEFAULT = false;

export const GATE_EDIT_EXEMPLAR_CAPTURE_SETTINGS: SettingDescriptor[] = [
  {
    key: GATE_EDIT_EXEMPLAR_CAPTURE_ENABLED_KEY,
    tier: 'global-kv',
    dataType: 'boolean',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'all',
    globalOnly: true,
    failMode: 'open-to-default',
    category: 'Consultation Feedback',
    label: 'Capture gate-edit exemplars',
    description:
      'When enabled, signed-note edits and clinician feedback are mined into PHI-redacted gate-edit exemplars. When disabled ' +
      '(the default) no exemplar row is written and no redaction is attempted; existing exemplars are still readable and exportable.',
    default: GATE_EDIT_EXEMPLAR_CAPTURE_ENABLED_DEFAULT,
  },
];
