// The assembled HOPE settings catalog.
//
// Feature modules contribute descriptor arrays; this is the single queryable
// registry, seeded with the verified, admin-controllable settings across the
// tiers (pipeline config, TTS BYO secrets, entitlements). Consumers include
// the catalog endpoint, server-side categories, and the generalized
// effective-config resolver.

import { AGENTIC_CONTEXT_SETTINGS } from './descriptors/agentic-context.descriptors';
import { AGENTIC_EVAL_SETTINGS } from './descriptors/agentic-eval.descriptors';
import { AGENTIC_FEWSHOT_SETTINGS } from './descriptors/agentic-fewshot.descriptors';
import { AGENTIC_REVISIT_SETTINGS } from './descriptors/agentic-revisit.descriptors';
import { BOOTSTRAP_ENV_SETTINGS } from './descriptors/bootstrap-env.descriptors';
import { ENTITLEMENT_SETTINGS } from './descriptors/entitlements.descriptors';
import { FEATURE_FLAG_SETTINGS } from './descriptors/feature-flags.descriptors';
import { MODEL_DEFAULT_SETTINGS } from './descriptors/model-defaults.descriptors';
import { PIPELINE_SETTINGS } from './descriptors/pipeline.descriptors';
import { PLATFORM_KNOB_SETTINGS, RATE_LIMIT_TIER_SETTINGS } from './descriptors/platform-knobs.descriptors';
import { PLATFORM_OPS_SETTINGS } from './descriptors/platform-ops.descriptors';
import { PLATFORM_SECRET_SETTINGS } from './descriptors/platform-secrets.descriptors';
import { SERVICE_RUNTIME_SETTINGS } from './descriptors/service-runtime.descriptors';
import { SMR_PROVIDER_CONNECTION_SETTINGS } from './descriptors/smr-provider-connections.descriptors';
import { STORAGE_SETTINGS } from './descriptors/storage.descriptors';
import { STT_FALLBACK_SETTINGS } from './descriptors/stt-fallback.descriptors';
import { TTS_SETTINGS } from './descriptors/tts.descriptors';
import { SettingsRegistry } from './settings-registry';

export const HOPE_SETTINGS_REGISTRY: SettingsRegistry = new SettingsRegistry().registerAll([
  ...PIPELINE_SETTINGS,
  // Platform storage default: SYSTEM TenantStorageConfig row + Vault kv-v2 (lane E).
  ...STORAGE_SETTINGS,
  ...TTS_SETTINGS,
  // Per-tenant STT fallback pipeline pointer + BYO provider credentials (TASK-567).
  ...STT_FALLBACK_SETTINGS,
  ...ENTITLEMENT_SETTINGS,
  // AI task-model defaults (guardrail/NLP/SMR).
  ...MODEL_DEFAULT_SETTINGS,
  // agentic context-management strategy knobs.
  ...AGENTIC_CONTEXT_SETTINGS,
  // agentic eval promotion-gate mode (block | warn | off).
  ...AGENTIC_EVAL_SETTINGS,
  // Re-visit carry-forward (default OFF) — TASK-553 F-18.
  ...AGENTIC_REVISIT_SETTINGS,
  // Few-shot exemplar curation gate (default off) — TASK-553 F-24.
  ...AGENTIC_FEWSHOT_SETTINGS,
  // The formerly orphaned platform-ops keys (rate limiting, audit
  // retention, agent-trajectory retention). Registered at their CURRENT runtime
  // defaults, so cataloging them changes no behaviour.
  ...PLATFORM_OPS_SETTINGS,
  // Stt-v2/nlp service-runtime knobs, consumed over the internal
  // effective-config route. Registered at their current Python defaults, so
  // cataloging them changes no behaviour.
  ...SERVICE_RUNTIME_SETTINGS,
  // SMR cloud-provider (openai/anthropic/vertex) platform CONNECTION config —
  // tier `env`, read by apps/smr. Registered at their config.py defaults, so
  // cataloging them changes no behaviour (TASK-572).
  ...SMR_PROVIDER_CONNECTION_SETTINGS,

  // ── TASK-558 lane F — taxonomy coverage ──────────────────────────────────
  // Platform secrets (Vault kv-v2). Every one is `failMode: 'closed'`, enforced
  // by `SettingsRegistry.register`.
  ...PLATFORM_SECRET_SETTINGS,
  // The bootstrap floor: the variables required to REACH the database or
  // AUTHENTICATE to Vault. Not admin-editable (`editableBy: 'none'`) — declared
  // so the catalog is complete and lane D can generate the per-deployable schema.
  ...BOOTSTRAP_ENV_SETTINGS,
  // Operational knobs still read from env, carrying `targetTier: 'global-kv'`.
  ...PLATFORM_KNOB_SETTINGS,
  // Rate-limit TIER policy — genuinely `global-kv` today (RateLimitSettingsService
  // already resolves them from GlobalSetting); they were simply never cataloged.
  ...RATE_LIMIT_TIER_SETTINGS,
  // Feature gates still read from env, carrying `targetTier: 'redis-flag'`.
  ...FEATURE_FLAG_SETTINGS,

  // ╔══════════════════════════════════════════════════════════════════════════╗
  // ║ REGISTRATION POINT — TASK-558 lane E (storage config → DB + Vault)        ║
  // ║                                                                          ║
  // ║ Lane E owns `descriptors/storage.descriptors.ts`; lane F deliberately did ║
  // ║ not create, read or modify it. To wire it in, add the import above and    ║
  // ║ ONE line here:                                                           ║
  // ║                                                                          ║
  // ║     ...STORAGE_SETTINGS,                                                 ║
  // ║                                                                          ║
  // ║ CONTRACT ITS DESCRIPTORS MUST MEET (lane F, F1):                         ║
  // ║  • `failMode` is REQUIRED on every descriptor — the build fails without   ║
  // ║    it. Storage ENDPOINT/REGION/PATH-STYLE/PREFIX are tuning →             ║
  // ║    'open-to-default'; anything `sensitivity: 'secret'` (a credentialsRef  ║
  // ║    target, a BYO tenant key) MUST be 'closed' — `register()` throws       ║
  // ║    otherwise, at module load.                                            ║
  // ║  • If a value is still read from `MINIO_*` env after lane E, declare      ║
  // ║    `tier: 'env'` + `targetTier: 'db-config'` rather than claiming the DB  ║
  // ║    tier early; flip `tier` and drop `targetTier` when the READER moves.   ║
  // ║  • env-tier descriptors use `editableBy: EDITABLE_BY_NONE`; a governance  ║
  // ║    test binds that both ways.                                            ║
  // ╚══════════════════════════════════════════════════════════════════════════╝
]);
