// Few-shot exemplar curation descriptor.
//
// `agentic.fewshot.curationMode` governs whether the gate-edit few-shot retriever
// honours the human curation verdict on `GateEditExemplar.curationStatus`:
//
//   'off' (default) — every mined APPROVED_CLEAN row is eligible, exactly the
//                     prior behaviour.
//   'enforce'       — only rows a curator moved to APPROVED are shown to the model.
//
// Default `off` so adding the column + endpoint changes nothing until a
// deployment has actually staffed the curation queue: flipping straight to
// `enforce` on an uncurated corpus would silently empty the few-shot block (a
// quality regression that looks like a retrieval outage).
//
// GLOBAL-ADMIN-ONLY (the `agentic.*` privilege boundary — a privilege rule → 403,
// enforced at the service/route layer, not a cross-tenant probe), tier
// `global-kv`, resolved through `EffectiveSettingsService.resolveEffective` so a
// write via `PUT /admin/settings/registry/:key` governs retrieval with no redeploy.

import { SettingDescriptor } from '../registry.types';

/** The curation-gate modes for the few-shot exemplar retriever. */
export type FewShotCurationMode = 'off' | 'enforce';

export const AGENTIC_FEWSHOT_CURATION_MODE_KEY = 'agentic.fewshot.curationMode';

/** Code default — the gate is catalogued but not enforced. */
export const AGENTIC_FEWSHOT_CURATION_MODE_DEFAULT: FewShotCurationMode = 'off';

// ── Quality-signal thresholds (TASK-792 W5 / TASK-789 M-9) ──────────────────
//
// These two ratios decide the TRAINING-LABEL TAXONOMY: which signed encounters
// become `APPROVED_CLEAN` ("imitate this" few-shot exemplars) and which become
// `HEAVILY_EDITED`. They shipped as TS literals in `gate-edit-mining.service.ts`,
// which rule 00 §Configuration Principles forbids — a threshold is config. That
// was moot only while the pipeline had no live writer; TASK-792 W1 gave it one.
//
// `editDistanceRatio` is the fraction of the delivered note's words the clinician
// changed. The band BETWEEN the two is deliberately never mined: an ambiguous
// example teaches the model an ambiguous lesson.

export const AGENTIC_FEWSHOT_APPROVED_CLEAN_MAX_RATIO_KEY = 'agentic.fewshot.approvedCleanMaxRatio';
export const AGENTIC_FEWSHOT_HEAVILY_EDITED_MIN_RATIO_KEY = 'agentic.fewshot.heavilyEditedMinRatio';

/** Code defaults — the literals this ticket replaced, unchanged in value. */
export const AGENTIC_FEWSHOT_APPROVED_CLEAN_MAX_RATIO_DEFAULT = 0.05;
export const AGENTIC_FEWSHOT_HEAVILY_EDITED_MIN_RATIO_DEFAULT = 0.3;

export const AGENTIC_FEWSHOT_SETTINGS: SettingDescriptor[] = [
  {
    key: AGENTIC_FEWSHOT_CURATION_MODE_KEY,
    tier: 'global-kv',
    dataType: 'enum',
    sensitivity: 'internal',
    // agentic.* is GLOBAL-ADMIN-only — platform-owned, not tenant-set.
    maxScope: 'system',
    editableBy: 'all',
    globalOnly: true,
    // Mode knob — unset degrades to the code default (`off`), i.e. today's behaviour.
    failMode: 'open-to-default',
    category: 'Agentic Few-Shot',
    label: 'Few-shot exemplar curation mode',
    description:
      'Governs the human curation gate on mined gate-edit exemplars: off (every APPROVED_CLEAN row is eligible) or ' +
      'enforce (only curator-APPROVED rows reach the prompt).',
    default: AGENTIC_FEWSHOT_CURATION_MODE_DEFAULT,
  },
  {
    key: AGENTIC_FEWSHOT_APPROVED_CLEAN_MAX_RATIO_KEY,
    tier: 'global-kv',
    dataType: 'number',
    sensitivity: 'internal',
    // Same `agentic.*` privilege boundary as every sibling key in this file.
    // Whether the TAXONOMY should instead be tenant-tunable is a live owner
    // question (rule 00 §2 defaults to tenant -> SYSTEM, and this namespace is a
    // documented super-admin-only exception). Widening it is a scope change, not
    // a code change: `resolveEffective` is already called with the candidate's
    // tenantId, so a tenant row would be honoured the moment maxScope allows one.
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
