// Gate-edit quality-signal thresholds (TASK-792 W5 / TASK-789 M-9).
//
// These two ratios decide the TRAINING-LABEL TAXONOMY: which signed encounters
// become `APPROVED_CLEAN` ("imitate this" few-shot exemplars) and which become
// `HEAVILY_EDITED`. They shipped as bare TS literals in `gate-edit-mining.service.ts`,
// which rule 00 §Configuration Principles forbids — a threshold is config, not a
// constant. That was moot only while the pipeline had no live writer; TASK-792 W1
// gave it one, so it is a live violation now.
//
// `editDistanceRatio` is the fraction of the delivered note's words the clinician
// changed. The band BETWEEN the two thresholds is deliberately never mined: an
// ambiguous example teaches the model an ambiguous lesson.
//
// ─── Why the descriptors live HERE and not in `settings-registry/descriptors/` ───
//
// `packages/applications/src/services/settings-registry/**` belongs to no ticket
// in the TASK-789 remediation ownership map, so TASK-792 may not edit it. The
// KEYS, DEFAULTS and descriptor definitions therefore live in this file (which
// TASK-792 owns) and are exported ready to register.
//
// Registering `GATE_EDIT_QUALITY_THRESHOLD_SETTINGS` into
// `settings-registry/registry.ts` is a REQUESTED CONTRACT — see the ticket
// README under `## Requested contracts`. Until that lands, `resolveEffective`
// raises `getOrThrow` for an unknown key, `GateEditMiningService` catches it and
// degrades to the code defaults below, and labelling is byte-identical to the
// pre-ticket behaviour. Unregistered is SAFE, not broken; registering it is what
// makes the taxonomy retunable without a redeploy.

import { SettingDescriptor } from '../settings-registry/registry.types';

export const AGENTIC_FEWSHOT_APPROVED_CLEAN_MAX_RATIO_KEY = 'agentic.fewshot.approvedCleanMaxRatio';
export const AGENTIC_FEWSHOT_HEAVILY_EDITED_MIN_RATIO_KEY = 'agentic.fewshot.heavilyEditedMinRatio';

/** Code defaults — the literals this ticket replaced, unchanged in value. */
export const AGENTIC_FEWSHOT_APPROVED_CLEAN_MAX_RATIO_DEFAULT = 0.05;
export const AGENTIC_FEWSHOT_HEAVILY_EDITED_MIN_RATIO_DEFAULT = 0.3;

export const GATE_EDIT_QUALITY_THRESHOLD_SETTINGS: SettingDescriptor[] = [
  {
    key: AGENTIC_FEWSHOT_APPROVED_CLEAN_MAX_RATIO_KEY,
    tier: 'global-kv',
    dataType: 'number',
    sensitivity: 'internal',
    // Same `agentic.*` privilege boundary as every sibling key in
    // `agentic-fewshot.descriptors.ts`. Whether this TAXONOMY should instead be
    // tenant-tunable is a live OWNER question: rule 00 §2 defaults to
    // tenant → SYSTEM, but the whole `agentic.*` namespace is a documented
    // super-admin-only exception, and widening it is a scope decision rather
    // than a code change. `resolveEffective` is already called with the
    // candidate's own tenantId, so a tenant row is honoured the moment
    // `maxScope` permits one — no further code change required.
    maxScope: 'system',
    editableBy: 'all',
    globalOnly: true,
    // A tuning knob, not a selection: unresolved degrades to the code default.
    failMode: 'open-to-default',
    category: 'Agentic Few-Shot',
    label: 'APPROVED_CLEAN maximum edit-distance ratio',
    description:
      'A signed note whose clinician edit-distance ratio is at or below this value is labelled APPROVED_CLEAN and is ' +
      'eligible as a few-shot style exemplar. Must be strictly below the HEAVILY_EDITED minimum.',
    default: AGENTIC_FEWSHOT_APPROVED_CLEAN_MAX_RATIO_DEFAULT,
  },
  {
    key: AGENTIC_FEWSHOT_HEAVILY_EDITED_MIN_RATIO_KEY,
    tier: 'global-kv',
    dataType: 'number',
    sensitivity: 'internal',
    maxScope: 'system',
    editableBy: 'all',
    globalOnly: true,
    failMode: 'open-to-default',
    category: 'Agentic Few-Shot',
    label: 'HEAVILY_EDITED minimum edit-distance ratio',
    description:
      'A signed note whose clinician edit-distance ratio is at or above this value is labelled HEAVILY_EDITED. Ratios ' +
      'between the two thresholds are deliberately not mined at all.',
    default: AGENTIC_FEWSHOT_HEAVILY_EDITED_MIN_RATIO_DEFAULT,
  },
];
