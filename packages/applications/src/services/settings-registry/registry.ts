// TASK-504 Phase 3 — the assembled HOPE settings catalog.
//
// Feature modules contribute descriptor arrays; this is the single queryable
// registry. Phase 3a seeds it with the verified, admin-controllable settings
// across the tiers (pipeline config, TTS BYO secrets, entitlements). Later
// sub-phases add more registrants and wire consumers (catalog endpoint,
// server-side categories, the generalized effective-config resolver).

import { AGENTIC_CONTEXT_SETTINGS } from './descriptors/agentic-context.descriptors';
import { ENTITLEMENT_SETTINGS } from './descriptors/entitlements.descriptors';
import { MODEL_DEFAULT_SETTINGS } from './descriptors/model-defaults.descriptors';
import { PIPELINE_SETTINGS } from './descriptors/pipeline.descriptors';
import { TTS_SETTINGS } from './descriptors/tts.descriptors';
import { SettingsRegistry } from './settings-registry';

export const HOPE_SETTINGS_REGISTRY: SettingsRegistry = new SettingsRegistry().registerAll([
  ...PIPELINE_SETTINGS,
  ...TTS_SETTINGS,
  ...ENTITLEMENT_SETTINGS,
  // TASK-506 — AI task-model defaults (guardrail/NLP/SMR).
  ...MODEL_DEFAULT_SETTINGS,
  // TASK-511 (Phase 3A) — agentic context-management strategy knobs.
  ...AGENTIC_CONTEXT_SETTINGS,
]);
