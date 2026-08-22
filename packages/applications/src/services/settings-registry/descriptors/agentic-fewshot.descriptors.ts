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
];
