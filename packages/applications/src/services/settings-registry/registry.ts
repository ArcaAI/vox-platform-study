// The assembled HOPE settings catalog.
//
// Feature modules contribute descriptor arrays; this is the single queryable
// registry, seeded with the verified, admin-controllable settings across the
// tiers (pipeline config, TTS BYO secrets, entitlements). Consumers include
// the catalog endpoint, server-side categories, and the generalized
// effective-config resolver.

import { AGENTIC_CONTEXT_SETTINGS } from './descriptors/agentic-context.descriptors';
import { ENTITLEMENT_SETTINGS } from './descriptors/entitlements.descriptors';
import { MODEL_DEFAULT_SETTINGS } from './descriptors/model-defaults.descriptors';
import { PIPELINE_SETTINGS } from './descriptors/pipeline.descriptors';
import { PLATFORM_OPS_SETTINGS } from './descriptors/platform-ops.descriptors';
import { SERVICE_RUNTIME_SETTINGS } from './descriptors/service-runtime.descriptors';
import { TTS_SETTINGS } from './descriptors/tts.descriptors';
import { SettingsRegistry } from './settings-registry';

export const HOPE_SETTINGS_REGISTRY: SettingsRegistry = new SettingsRegistry().registerAll([
  ...PIPELINE_SETTINGS,
  ...TTS_SETTINGS,
  ...ENTITLEMENT_SETTINGS,
  // AI task-model defaults (guardrail/NLP/SMR).
  ...MODEL_DEFAULT_SETTINGS,
  // agentic context-management strategy knobs.
  ...AGENTIC_CONTEXT_SETTINGS,
  // The formerly orphaned platform-ops keys (rate limiting, audit
  // retention, agent-trajectory retention). Registered at their CURRENT runtime
  // defaults, so cataloging them changes no behaviour.
  ...PLATFORM_OPS_SETTINGS,
  // Stt-v2/nlp service-runtime knobs, consumed over the internal
  // effective-config route. Registered at their current Python defaults, so
  // cataloging them changes no behaviour.
  ...SERVICE_RUNTIME_SETTINGS,
]);
