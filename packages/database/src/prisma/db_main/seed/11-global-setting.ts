import type { CorePrismaClient } from '../../../client';
import { ResourceStatusType, ValueType } from '../../../generated/core-prisma-client/client.js';
import {
  SEED_CUSTOMER_TENANT_IDS,
  SEED_TENANT_ID,
  SEED_USER_IDS,
  SEED_GLOBAL_SETTING_IDS,
  SEED_ROLE_IDS,
  SYSTEM_TENANT_ID,
  SYSTEM_USER_ID,
} from './00-constants';

/**
 * Per-Tenant Global Settings Seed Data
 *
 * Seeds general settings, feature flags, STT, TEXT, and UX constants for
 * every tenant (Global + customer tenants) so the admin panel and SDK
 * always see populated configuration.
 *
 * Every tenant gets the same 13 settings (consolidated):
 *   - general       (3) — session limits, language, timeouts
 *   - feature-flags (1) — `enable-consultation-sharing`, the one flag here with
 *                         a real runtime consumer (TASK-932 R-8 removed five
 *                         advisory rows that had none)
 *   - stt           (2) — speech-to-text defaults
 *   - text           (1) — Azure deployment name (non-secret)
 *   - ux-constants  (4) — static model lists + guardrail provider catalog
 *   - admin         (1) — locked config paths
 *   - arcaai-admin  (1) — admin-console menu order
 *
 * The text default-provider/default-model keys, the ad-hoc
 * `text-provider-models` UI catalog and the entire `guardrail` namespace are
 * RETIRED (superseded by the `AiRoutingPolicy` table + registry-backed provider
 * listings). They are removed from the seeded arrays and swept to
 * resourceStatus DELETED by `retireSupersededGlobalSettings` below.
 *
 * Uses upsert on the (tenantId, name, key) composite unique constraint
 * to remain idempotent across repeated runs.
 */

const IDS = SEED_GLOBAL_SETTING_IDS;
const CREATED_BY = SEED_USER_IDS.SUPER_ADMIN;

interface SettingDef {
  id: string;
  tenantId: string;
  namespace: string;
  name: string;
  key: string;
  value: string;
  defaultValue: string;
  dataType: ValueType;
  description: string;
  locked?: boolean;
}

// =============================================================================
// UX Constants — static model lists for UI dropdowns
//
// These define the available local browser models that the SDK can use.
// The UI reads these to populate <select> dropdowns on the Installation
// pages (STT, VAD, Noise Filter). Seeded per-tenant so each tenant gets
// the same consolidated set of 24 settings.
// =============================================================================

const LOCAL_ASR_MODELS = JSON.stringify([
  { id: 'whisper-tiny', name: 'Whisper Tiny', size: '~75 MB' },
  { id: 'whisper-base', name: 'Whisper Base', size: '~150 MB' },
  { id: 'whisper-small', name: 'Whisper Small', size: '~500 MB' },
]);

const LOCAL_VAD_MODELS = JSON.stringify([
  { id: 'silero-v5', name: 'Silero VAD v5' },
  { id: 'silero-v6', name: 'Silero VAD v6' },
]);

const LOCAL_NOISE_SUPPRESSION_MODELS = JSON.stringify([{ id: 'rnnoise', name: 'RNNoise' }]);

// =============================================================================
// The TEXT provider-model catalog (`TEXT_PROVIDER_MODELS`,
// `text-provider-models` ux-constants key) was RETIRED: provider/model listings
// now come from the AiModel registry (ENABLED rows grouped by `provider`), and
// the platform text/summarization default lives on HarnessPolicy
// (13-harness-policy.ts) + the AiRoutingPolicy elected defaults (16-ai-routing-policy.ts, TASK-862).
// =============================================================================

// =============================================================================
// Guardrail Provider-Model Catalog — available content-safety /
// guardrail providers and models.
//
// Seeded per-tenant so the admin console can populate the Guardrail
// provider/model selectors. Admins pick a default provider + model from this
// catalog. Mirrors the TEXT catalog shape. LM Studio (OpenAI-compatible) is the
// default/primary local engine and MUST expose the default Granite Guardian
// model `granite-guardian-4.1-8b` (cross-worker contract with the Guardrail
// Python service).
// =============================================================================

export const GUARDRAIL_PROVIDER_NAMES = ['lm-studio', 'ollama', 'azure-openai'] as const;

export const GUARDRAIL_PROVIDER_MODELS = [
  {
    provider: 'lm-studio',
    models: [
      { name: 'granite-guardian-4.1-8b', size: '4.9 GB' },
      { name: 'ibm-granite/granite-guardian-3.2-5b', size: '3.1 GB' },
      { name: 'ibm-granite/granite-guardian-3.2-3b-a800m', size: '1.9 GB' },
    ],
  },
  {
    provider: 'ollama',
    models: [
      { name: 'granite3-guardian:8b', size: '4.9 GB' },
      { name: 'granite3-guardian:2b', size: '1.6 GB' },
    ],
  },
  {
    provider: 'azure-openai',
    models: [{ name: 'gpt-4o-mini', size: '' }],
  },
] as const;

const GUARDRAIL_PROVIDER_MODELS_JSON = JSON.stringify(GUARDRAIL_PROVIDER_MODELS);

// =============================================================================
// Admin Console Menu Order
//
// Seeds the TENANT tier of the admin console's menu-order resolver
// (USER → TENANT → DEFAULT). The console reads this under the server-owned
// `arcaai-admin` namespace / `menuOrder` key. Canonical order keeps "studio"
// LAST so a tenant default is observably different from any client fallback.
// =============================================================================

const ADMIN_MENU_ORDER_JSON = JSON.stringify([
  'overview',
  'dna-reports',
  'tenants',
  'users',
  'prompts',
  'departments',
  'audio-pipelines',
  'storage',
  'configurations',
  'audit-logs',
  'studio',
]);

function tenantSettings(
  tenantId: string,
  ids: {
    genMaxConcurrentSessions: string;
    genDefaultLanguage: string;
    genSessionTimeout: string;
    sttModel: string;
    sttVad: string;
    textAzureDeployment: string;
    uxLocalAsrModels: string;
    uxLocalVadModels: string;
    uxLocalNoiseSuppressionModels: string;
    uxGuardrailProviderModels: string;
    lockedConfigPaths: string;
    adminMenuOrder: string;
  },
): SettingDef[] {
  return [
    // ── general (3) ─────────────────────────────────────────────────
    {
      id: ids.genMaxConcurrentSessions,
      tenantId,
      namespace: 'general',
      name: 'Max Concurrent Sessions',
      key: 'max-concurrent-sessions',
      value: '10',
      defaultValue: '10',
      dataType: ValueType.Integer,
      description: 'Maximum number of concurrent active consultation sessions allowed per user',
    },
    {
      id: ids.genDefaultLanguage,
      tenantId,
      namespace: 'general',
      name: 'Default Language',
      key: 'default-language',
      value: 'en',
      defaultValue: 'en',
      dataType: ValueType.String,
      description: 'Default UI and transcription language (ISO 639-1 code)',
    },
    {
      id: ids.genSessionTimeout,
      tenantId,
      namespace: 'general',
      name: 'Session Timeout',
      key: 'session-timeout',
      value: '30',
      defaultValue: '30',
      dataType: ValueType.Integer,
      description: 'Idle session timeout in minutes before automatic logout',
    },

    // ── feature-flags (0) ───────────────────────────────────────────
    //
    // TASK-932 R-8 removed FIVE advisory rows from here (listed in
    // `RETIRED_GLOBAL_SETTING_KEYS` below so an already-provisioned database
    // sweeps its copies to DELETED rather than keeping them ENABLED forever):
    //
    //   enable-transcription  enable-dna-style  enable-cross-chain-summary
    //   enable-ner-extraction  enable-code-switching
    //
    // None of them had a runtime consumer. No gateway module read them, and the
    // SDK's own `TENANT_CONFIG_KEYS.ENABLE_REAL_TIME_TRANSCRIPTION` constant is
    // `'enable-real-time-transcription'` -- which does not even MATCH the seeded
    // `'enable-transcription'`, so the computed flag was doubly disconnected.
    // Toggling one in the console changed nothing at runtime, which is exactly
    // the kind of control surface the owner asked to be removed rather than
    // labelled: the console shipped an `isAdvisoryFeatureFlag()` marker to warn
    // an admin that a toggle did nothing, and a toggle that needs that warning
    // should not exist. That marker is deleted with these rows.
    //
    // TASK-932 wave 4 owner decision OD-1 (2026-09-09) now ALSO stops cloning
    // `enable-consultation-sharing` per tenant, the last row this block ever
    // carried. It is genuinely enforced (`ConsultationController
    // .isSharingEnabled()`), but the enforcement is moving onto the settings
    // registry cascade (lane S2): a `maxScope: 'tenant'` descriptor with
    // `default: true` now supplies the SAME effective value on absence, so a
    // per-tenant explicit `true` clone is redundant with the descriptor
    // default rather than an override of it. The existing clones are swept to
    // DELETED by `RETIRED_GLOBAL_SETTING_KEYS` below so every tenant inherits
    // the descriptor default instead of keeping a now-redundant explicit row.

    // ── stt (2) ─────────────────────────────────────────────────────
    {
      id: ids.sttModel,
      tenantId,
      namespace: 'stt',
      name: 'Default STT Model',
      key: 'default-stt-model',
      // whisper-large-v3 was retired from the AiModel catalog;
      // the surviving backend ASR default is the turbo variant.
      value: 'whisper-large-v3-turbo',
      defaultValue: 'whisper-large-v3-turbo',
      dataType: ValueType.String,
      description: 'Default speech-to-text model slug used for backend transcription (not used for local browser STT)',
      locked: true,
    },
    {
      id: ids.sttVad,
      tenantId,
      namespace: 'stt',
      name: 'VAD Sensitivity',
      key: 'vad-sensitivity',
      value: '0.5',
      defaultValue: '0.5',
      dataType: ValueType.Float,
      description: 'Voice activity detection sensitivity threshold (0.0–1.0)',
      locked: true,
    },

    // ── text (1) ─────────────────────────────────────────────────────
    // default-text-provider / default-text-model RETIRED: the
    // platform summarization default lives on HarnessPolicy (SYSTEM row,
    // 13-harness-policy.ts); provider/model listings come from the AiModel
    // registry. Only the non-secret Azure deployment name remains here.
    {
      // Azure OpenAI deployment NAME for TEXT (non-secret).
      // The Azure API key remains env/Vault only (never a plaintext
      // GlobalSetting); only the deployment name is DB-driven. Not locked
      // so tenant admins can set their own Azure deployment.
      id: ids.textAzureDeployment,
      tenantId,
      namespace: 'text',
      name: 'TEXT Azure Deployment',
      key: 'text-azure-deployment',
      value: '',
      defaultValue: '',
      dataType: ValueType.String,
      description: 'Azure OpenAI deployment name used by TEXT when provider=azure-openai (non-secret; the API key stays in env/Vault)',
    },

    // ── guardrail (0) — RETIRED ──────────────────────────
    // The guardrail namespace (default-guardrail-provider /
    // default-guardrail-model / guardrail-azure-deployment) is superseded
    // by the AiRoutingPolicy table (`guardrail.validate` key, GLOBAL-ADMIN-
    // ONLY writes) + the AiModel registry. Existing rows are swept to
    // DELETED by retireSupersededGlobalSettings.

    // ── ux-constants (4) ────────────────────────────────────────────
    {
      id: ids.uxLocalAsrModels,
      tenantId,
      namespace: 'ux-constants',
      name: 'Local ASR Models',
      key: 'local-asr-models',
      value: LOCAL_ASR_MODELS,
      defaultValue: LOCAL_ASR_MODELS,
      dataType: ValueType.Json,
      description: 'Available local browser-based ASR (Whisper) task models for the SDK installation page',
      locked: true,
    },
    {
      id: ids.uxLocalVadModels,
      tenantId,
      namespace: 'ux-constants',
      name: 'Local VAD Models',
      key: 'local-vad-models',
      value: LOCAL_VAD_MODELS,
      defaultValue: LOCAL_VAD_MODELS,
      dataType: ValueType.Json,
      description: 'Available local browser-based VAD (Silero) models for the SDK installation page',
      locked: true,
    },
    {
      id: ids.uxLocalNoiseSuppressionModels,
      tenantId,
      namespace: 'ux-constants',
      name: 'Local Noise Suppression Models',
      key: 'local-noise-suppression-models',
      value: LOCAL_NOISE_SUPPRESSION_MODELS,
      defaultValue: LOCAL_NOISE_SUPPRESSION_MODELS,
      dataType: ValueType.Json,
      description: 'Available local browser-based noise suppression models for the SDK installation page',
      locked: true,
    },
    // The `text-provider-models` catalog key is RETIRED (the
    // AiModel registry is the single provider/model catalog).
    {
      // Guardrail provider/model catalog mirroring the TEXT one.
      id: ids.uxGuardrailProviderModels,
      tenantId,
      namespace: 'ux-constants',
      name: 'Guardrail Provider Models',
      key: 'guardrail-provider-models',
      value: GUARDRAIL_PROVIDER_MODELS_JSON,
      defaultValue: GUARDRAIL_PROVIDER_MODELS_JSON,
      dataType: ValueType.Json,
      description: 'Available providers and models for the Guardrail content-safety service (admin selects default from this catalog)',
      locked: true,
    },
    // ── admin (1) ────────────────────────────────────────────────────
    {
      id: ids.lockedConfigPaths,
      tenantId,
      namespace: 'admin',
      name: 'Locked Config Paths',
      key: 'locked-config-paths',
      value: JSON.stringify([
        'stt.defaultModel',
        'audio.codeSwitching',
        'features.realTimeTranscription',
        'features.nerExtraction',
        'features.dnaStyle',
        'features.crossChainSummary',
      ]),
      defaultValue: JSON.stringify([
        'stt.defaultModel',
        'audio.codeSwitching',
        'features.realTimeTranscription',
        'features.nerExtraction',
        'features.dnaStyle',
        'features.crossChainSummary',
      ]),
      dataType: ValueType.Json,
      description: 'Config paths that are locked and editable only by admins',
    },
    // ── arcaai-admin (1) ──────────────────────────────────────────────
    {
      id: ids.adminMenuOrder,
      tenantId,
      namespace: 'arcaai-admin',
      name: 'Admin Menu Order',
      key: 'menuOrder',
      value: ADMIN_MENU_ORDER_JSON,
      defaultValue: ADMIN_MENU_ORDER_JSON,
      dataType: ValueType.Json,
      description: 'Default admin-console left-nav menu order (TENANT tier of the USER → TENANT → DEFAULT resolver)',
    },
  ];
}

export const ALL_SETTINGS: SettingDef[] = [
  ...tenantSettings(SEED_TENANT_ID, {
    genMaxConcurrentSessions: IDS.GLOBAL_MAX_CONCURRENT_SESSIONS,
    genDefaultLanguage: IDS.GLOBAL_DEFAULT_LANGUAGE,
    genSessionTimeout: IDS.GLOBAL_SESSION_TIMEOUT,
    sttModel: IDS.GLOBAL_STT_MODEL,
    sttVad: IDS.GLOBAL_STT_VAD,
    textAzureDeployment: IDS.GLOBAL_TEXT_AZURE_DEPLOYMENT,
    uxLocalAsrModels: IDS.GLOBAL_UX_LOCAL_ASR_MODELS,
    uxLocalVadModels: IDS.GLOBAL_UX_LOCAL_VAD_MODELS,
    uxLocalNoiseSuppressionModels: IDS.GLOBAL_UX_LOCAL_NOISE_SUPPRESSION_MODELS,
    uxGuardrailProviderModels: IDS.GLOBAL_UX_GUARDRAIL_PROVIDER_MODELS,
    lockedConfigPaths: IDS.GLOBAL_LOCKED_CONFIG_PATHS,
    adminMenuOrder: IDS.GLOBAL_TENANT_ADMIN_MENU_ORDER,
  }),
  ...tenantSettings(SEED_CUSTOMER_TENANT_IDS.ARCAAI, {
    genMaxConcurrentSessions: IDS.ARCAAI_MAX_CONCURRENT_SESSIONS,
    genDefaultLanguage: IDS.ARCAAI_DEFAULT_LANGUAGE,
    genSessionTimeout: IDS.ARCAAI_SESSION_TIMEOUT,
    sttModel: IDS.ARCAAI_STT_MODEL,
    sttVad: IDS.ARCAAI_STT_VAD,
    textAzureDeployment: IDS.ARCAAI_TEXT_AZURE_DEPLOYMENT,
    uxLocalAsrModels: IDS.ARCAAI_UX_LOCAL_ASR_MODELS,
    uxLocalVadModels: IDS.ARCAAI_UX_LOCAL_VAD_MODELS,
    uxLocalNoiseSuppressionModels: IDS.ARCAAI_UX_LOCAL_NOISE_SUPPRESSION_MODELS,
    uxGuardrailProviderModels: IDS.ARCAAI_UX_GUARDRAIL_PROVIDER_MODELS,
    lockedConfigPaths: IDS.ARCAAI_LOCKED_CONFIG_PATHS,
    adminMenuOrder: IDS.ARCAAI_ADMIN_MENU_ORDER,
  }),
];

// =============================================================================
// Platform-owned settings (SYSTEM_TENANT_ID)
//
// The local raw-stream dual-capture capability is a PLATFORM gate,
// not a per-tenant flag: a single row owned by SYSTEM_TENANT_ID. The
// `AppSettingsService` cache is keyed flat by `key`, so one platform-scoped row
// resolves deterministically (the key is unique, so it never trips the
// boot-time duplicate-key invariant). Default OFF.
// =============================================================================
export const PLATFORM_SETTINGS: SettingDef[] = [
  {
    id: SEED_GLOBAL_SETTING_IDS.SYSTEM_FF_LOCAL_RAW_CAPTURE,
    tenantId: SYSTEM_TENANT_ID,
    namespace: 'feature-flags',
    name: 'Enable Local Raw Capture',
    key: 'enable-local-raw-capture',
    // Clinical Workflow Playground — platform capability turned ON so
    // the Global demo tenant's `TenantFrontendConfig.captureRawAudio = true`
    // becomes effective (GET /tenant/me/config returns the AND of the two).
    // `defaultValue` stays 'false' so a reset reverts to the fail-safe default.
    value: 'true',
    defaultValue: 'false',
    dataType: ValueType.Boolean,
    description:
      "Platform capability for local raw-stream dual-capture. The SDK-facing enablement is this AND the per-tenant TenantFrontendConfig.captureRawAudio toggle. SUPER_ADMIN-only — gated by the registry descriptor's `globalOnly`, not a row-level lock.",
    // TASK-932 wave 4 owner decision OD-2 (2026-09-09) — retired the
    // row-level lock now that lane S2's registry descriptor for this key
    // (`maxScope: 'system'`, `globalOnly: true`) is the SUPER_ADMIN-only
    // gate. One mechanism, not two: `locked` used to be this row's own
    // enforcement; the descriptor now owns it end to end.
    locked: false,
  },
  // Turn the nightly SYSTEM-template resync sweep ON.
  //
  // The sweep's registry descriptor is a KILL-SWITCH, and the settings
  // registry refuses at assembly to register a kill-switch that defaults ON
  // (fail-safe governance, `SettingsRegistry.killSwitches()`). So the sweep is
  // enabled the sanctioned way: the descriptor default stays OFF and this
  // platform VALUE turns it on. `defaultValue` stays 'false' so a reset
  // reverts to the fail-safe, and `locked` keeps the flip SUPER_ADMIN-only.
  //
  // Safe to run unattended by construction: the reconciler only ever adds
  // missing templates and fast-forwards copies it can prove are pristine. An
  // unlocked (customized) pipeline, or a locked copy that drifted from its own
  // version history, is skipped and logged — never overwritten.
  {
    id: SEED_GLOBAL_SETTING_IDS.SYSTEM_PIPELINE_TEMPLATE_RESYNC_ENABLED,
    tenantId: SYSTEM_TENANT_ID,
    namespace: 'pipeline',
    name: 'Enable Pipeline Template Resync',
    key: 'pipeline.templateResync.enabled',
    value: 'true',
    defaultValue: 'false',
    dataType: ValueType.Boolean,
    description:
      "Runs the nightly sweep that reconciles every tenant's ASR pipeline catalog against the SYSTEM templates . Customized pipelines are never touched. Locked — only SUPER_ADMIN may change it.",
    locked: true,
  },
  {
    id: SEED_GLOBAL_SETTING_IDS.SYSTEM_PIPELINE_TEMPLATE_RESYNC_CRON,
    tenantId: SYSTEM_TENANT_ID,
    namespace: 'pipeline',
    name: 'Pipeline Template Resync Schedule',
    key: 'pipeline.templateResync.cron',
    value: '0 3 * * *',
    defaultValue: '0 3 * * *',
    dataType: ValueType.String,
    description: 'Cron expression for the nightly SYSTEM-template resync sweep . Locked — only SUPER_ADMIN may change it.',
    locked: true,
  },
  // TASK-890 D-2 (owner answer, 2026-09-06) — turn TEXT's input/output moderation ON.
  //
  // `text.externalGuardrail.enabled` gates both halves of the TASK-871 gate. Its descriptor is a
  // KILL SWITCH, and the registry refuses at assembly to register a kill-switch that defaults ON
  // (fail-safe governance), so nothing seeded a value and the gates were INERT on every
  // deployment until someone flipped one key by hand. This is the sanctioned way to ship it on,
  // and it is the same shape as the two rows above: `value` is the live setting, `defaultValue`
  // keeps the OFF fallback so a reset reverts to fail-safe, `locked` restricts the flip to
  // SUPER_ADMIN, and the platform loop below is CREATE-ONLY on `value` — a deliberate flip
  // survives every re-seed.
  //
  // Two details that are load-bearing rather than cosmetic:
  //
  //   - NAMESPACE `registry`. `SettingsRegistryWriteService` finds its backing row by
  //     `(key, namespace: 'registry', tenantId)`. Seeded under any other namespace, the first
  //     governed write would not find this row and would CREATE A SECOND SYSTEM row for the same
  //     key — and two platform rows sharing a key trip `AppSettingsService`'s boot-time
  //     duplicate-key invariant, which refuses to start the gateway.
  //   - NAME `TEXT input moderation` matches `descriptor.label`, which is what that same write
  //     lane would name a row it created. Nothing keys on it (the lookup ignores `name`), but a
  //     divergence would leave two plausible names for one row in the console.
  //
  // The gate is fail-CLOSED by construction: with it on, a deployment whose `apps/text` cannot
  // reach `apps/guardrail` answers 503 on every generation rather than shipping unmoderated PHI.
  // That is the intended behaviour and the reason §3.14b makes a reachable guardrail a
  // precondition of this row on every stack, checked by the orchestrator — never by a lane.
  {
    // Same `0002` SYSTEM-tenant block as the two rows above. Declared here rather than in
    // `seed/00-constants.ts` only because this lane owns this file alone; move it up with the
    // siblings on the next pass through that file.
    id: '00000000-0000-0000-0002-000000000004',
    tenantId: SYSTEM_TENANT_ID,
    namespace: 'registry',
    name: 'TEXT input moderation',
    key: 'text.externalGuardrail.enabled',
    value: 'true',
    defaultValue: 'false',
    dataType: ValueType.Boolean,
    description:
      'Gates TEXT input and output moderation (TASK-871). ON since TASK-890 D-2. A tenant may opt OUT per agent / workflow / node; nothing can turn screening on that this switch turns off. Locked — only SUPER_ADMIN may change it.',
    locked: true,
  },
  // TASK-969 L4 (F-4/WS-4) — the other five `text.externalGuardrail.*` keys were resolving to
  // an invisible `code-default`: a platform admin could not see or edit the value actually in
  // force without guessing the key and creating a row. Seeded here at their current code-default
  // floors, verbatim, from `apps/text/src/text/core/runtime_defaults.py`
  // (`GUARDRAIL_REQUIRE_MEDICAL_FLOOR` / `GUARDRAIL_INCLUDE_REASONING_FLOOR` /
  // `GUARDRAIL_TIMEOUT_FLOOR_S` / `GUARDRAIL_MAX_RETRIES_FLOOR` / `GUARDRAIL_RETRY_BACKOFF_FLOOR_MS`),
  // so a fresh deployment behaves exactly as it does today and a platform admin sees five real
  // rows instead of five phantoms.
  //
  // Same shape as the row above: NAMESPACE `registry` (any other namespace makes the first
  // governed write create a SECOND SYSTEM row for the same key, tripping `AppSettingsService`'s
  // boot-time duplicate-key invariant and refusing gateway startup), NAME matches
  // `descriptor.label` (`text-provider-connections.descriptors.ts`), and `value`/`defaultValue`
  // are equal — these are tuning floors, not a fail-safe switch, so there is no "safer" value to
  // revert to on reset.
  //
  // HAZARD: do NOT seed `text.guardrailPolicy.*` here. Those are the TENANT half of the pair
  // (F-1) and have no reader at SYSTEM scope — a row there is the exact dead-write defect this
  // ticket exists to remove.
  {
    id: '00000000-0000-0000-0002-000000000007',
    tenantId: SYSTEM_TENANT_ID,
    namespace: 'registry',
    name: 'Require medical content (platform default)',
    key: 'text.externalGuardrail.requireMedical',
    value: 'true',
    defaultValue: 'true',
    dataType: ValueType.Boolean,
    description:
      'Platform default for clinical enforcement: a reachable guardrail must classify the prompt as medical before it is allowed. A tenant with its own opinion pushes it per request and wins; this is only what a tenant with no opinion inherits. Locked — only SUPER_ADMIN may change it.',
    locked: true,
  },
  {
    id: '00000000-0000-0000-0002-000000000008',
    tenantId: SYSTEM_TENANT_ID,
    namespace: 'registry',
    name: 'Include guardrail reasoning (platform default)',
    key: 'text.externalGuardrail.includeReasoning',
    value: 'false',
    defaultValue: 'false',
    dataType: ValueType.Boolean,
    description:
      'Platform default for whether the moderation call asks guardrail to return its reasoning. Off, since the reasoning can quote the prompt and would widen what crosses the service boundary. Locked — only SUPER_ADMIN may change it.',
    locked: true,
  },
  {
    id: '00000000-0000-0000-0002-000000000009',
    tenantId: SYSTEM_TENANT_ID,
    namespace: 'registry',
    name: 'Guardrail call timeout (s)',
    key: 'text.externalGuardrail.timeoutS',
    value: '10',
    defaultValue: '10',
    dataType: ValueType.Integer,
    description:
      'Per-attempt timeout, in seconds, on the moderation call TEXT makes before generating. Raise it only against the caller-side request timeout that bounds it. Locked — only SUPER_ADMIN may change it.',
    locked: true,
  },
  {
    id: '00000000-0000-0000-0002-000000000010',
    tenantId: SYSTEM_TENANT_ID,
    namespace: 'registry',
    name: 'Guardrail retry budget',
    key: 'text.externalGuardrail.maxRetries',
    value: '2',
    defaultValue: '2',
    dataType: ValueType.Integer,
    description:
      'Extra attempts after the first when the moderation call fails (total tries = this value + 1); 0 means no retry. A momentary blip is absorbed and the prompt proceeds, while a sustained outage exhausts the budget and fails closed. Locked — only SUPER_ADMIN may change it.',
    locked: true,
  },
  {
    id: '00000000-0000-0000-0002-000000000011',
    tenantId: SYSTEM_TENANT_ID,
    namespace: 'registry',
    name: 'Guardrail retry backoff (ms)',
    key: 'text.externalGuardrail.retryBackoffMs',
    value: '100',
    defaultValue: '100',
    dataType: ValueType.Integer,
    description:
      'Linear backoff, in milliseconds, between moderation retries: attempt N waits N times this value. Counts toward the latency ceiling described under the call timeout. Locked — only SUPER_ADMIN may change it.',
    locked: true,
  },
  // TASK-950 — identity auto-provisioning platform defaults (owner ask, 2026-09-11).
  //
  // A service-account request naming a context-schema "user identity" field resolves it to a
  // tenant User, provisioning one when no existing profile matches
  // (`ContextUserIdentityService`). These two `db-config` rows are the tenant -> SYSTEM cascade
  // fallback (`00-project-context.md` Configuration Principles rule 2): a tenant with no opinion
  // of its own inherits these; a tenant that writes its own row through the governed
  // settings-registry lane wins.
  //
  // `identity.autoProvision.departmentId` is DELIBERATELY NOT seeded here — departments are
  // per-tenant, so there is no platform-wide default to fall back to. Its resolution fails closed
  // (400 `USER_IDENTITY_DEPARTMENT_UNRESOLVED`) when a tenant has set no department and the
  // request carries none.
  //
  // `identity.autoProvision.enabled` follows the same shape as the three ON-by-default rows
  // above: `value` and `defaultValue` are BOTH 'true' (OD-3 — the owner's ask says HOPE "will create a
  // user"): the registry descriptor's open-to-default value is `true`, so a reset must land on the
  // same answer a missing row gives, not on a second, quieter default.
  {
    id: '00000000-0000-0000-0002-000000000005',
    tenantId: SYSTEM_TENANT_ID,
    namespace: 'identity',
    name: 'Identity Auto-Provision Enabled',
    key: 'identity.autoProvision.enabled',
    value: 'true',
    defaultValue: 'true',
    dataType: ValueType.Boolean,
    description:
      'Platform default (open-to-default) for whether a service-account request naming a context-schema user-identity field may provision a new tenant User when no existing profile matches (TASK-950). A tenant may opt out with its own row. Locked — only SUPER_ADMIN may change the platform default.',
    locked: true,
  },
  // `identity.autoProvision.roleId` — selection is `closed` (fail-mode): an unresolved value
  // raises rather than substituting a code literal, so the platform default lives HERE, as a seed
  // row, not in application code. Seeded to the SYSTEM `DOCTOR` role
  // (`SEED_ROLE_IDS.DOCTOR`) — the seeded clinical role carrying `consultation-own-manage`, the
  // ability `assertNamedClinicianMayOwnConsultation` requires. `value` and `defaultValue` are the
  // same id: unlike a capability flag, there is no "safer" fallback role to revert to on reset.
  {
    id: '00000000-0000-0000-0002-000000000006',
    tenantId: SYSTEM_TENANT_ID,
    namespace: 'identity',
    name: 'Identity Auto-Provision Role',
    key: 'identity.autoProvision.roleId',
    value: SEED_ROLE_IDS.DOCTOR,
    defaultValue: SEED_ROLE_IDS.DOCTOR,
    dataType: ValueType.String,
    description:
      'Platform default role (closed selection) assigned to a tenant User auto-provisioned from a context-schema identity field (TASK-950). Seeded to the SYSTEM DOCTOR role; a tenant may point this at its own cloned role. Locked — only SUPER_ADMIN may change the platform default.',
    locked: true,
  },
];

// =============================================================================
// Superseded GlobalSetting keys (soft-retire sweep)
//
// These six keys are replaced by the AiRoutingPolicy table + registry-backed
// provider listings in this same ticket. `retireSupersededGlobalSettings`
// sweeps EVERY tenant's copy to resourceStatus DELETED (idempotent; rows stay
// recoverable). NOTE: `default-stt-pipeline` and all other keys are untouched.
//
// The three `smr` literals below are DELIBERATELY NOT renamed by D-740-1. They are
// not identifiers this codebase chooses — they are the namespace/key of rows that
// ALREADY EXIST in every deployed database, and this list is the only thing that
// retires them. Renaming them to `text` would point the sweep at rows that do not
// exist, silently leaving the real `smr` rows ENABLED forever. They may only be
// dropped from this list once no database can still hold them.
// =============================================================================

export const RETIRED_GLOBAL_SETTING_KEYS: ReadonlyArray<{ namespace: string; key: string }> = [
  // TASK-932 R-8 — the five advisory `feature-flags` rows with no runtime
  // consumer. Dropping them from the seeded arrays stops a FRESH database
  // getting them; this list is what retires the copies an already-provisioned
  // one holds. They are toggles that did nothing, so retiring them removes a
  // control surface rather than a capability.
  { namespace: 'feature-flags', key: 'enable-transcription' },
  { namespace: 'feature-flags', key: 'enable-dna-style' },
  { namespace: 'feature-flags', key: 'enable-cross-chain-summary' },
  { namespace: 'feature-flags', key: 'enable-ner-extraction' },
  { namespace: 'feature-flags', key: 'enable-code-switching' },
  { namespace: 'smr', key: 'default-smr-provider' },
  { namespace: 'smr', key: 'default-smr-model' },
  { namespace: 'ux-constants', key: 'smr-provider-models' },
  { namespace: 'guardrail', key: 'default-guardrail-provider' },
  { namespace: 'guardrail', key: 'default-guardrail-model' },
  { namespace: 'guardrail', key: 'guardrail-azure-deployment' },
  // D-740-1 cutover: the Azure deployment name moved from `smr/smr-azure-deployment`
  // to `text/text-azure-deployment` (seeded above). The row is seed-written and has no
  // runtime reader, so this sweep is what stops the old copy lingering ENABLED in an
  // already-provisioned database. Any value a tenant had set under the old key is NOT
  // migrated — per owner decision D-A there is no production data, so this is a clean
  // cutover rather than a migration.
  { namespace: 'smr', key: 'smr-azure-deployment' },
  // TASK-932 wave 4 owner decision OD-1 (2026-09-09) — stop cloning
  // `enable-consultation-sharing` into every tenant. The registry cascade
  // (lane S2's `maxScope: 'tenant'` descriptor, `default: true`) now supplies
  // the SAME effective value on absence, so the per-tenant explicit `true`
  // clone this file used to seed (see `tenantSettings()` above) is
  // superseded rather than lost — every tenant still resolves `true` unless
  // it writes its own opinion through the governed lane.
  { namespace: 'feature-flags', key: 'enable-consultation-sharing' },
  // TASK-932 wave 4 owner decision OD-8 (2026-09-09) — retire the legacy
  // `S3_PUBLIC_BUCKET`/`S3_PRIVATE_BUCKET` platform bucket pair
  // (`06-stt.ts`'s `DEFAULT_STT_SETTINGS`, namespace `platform`). Zero
  // production consumers besides `S3Service.testConnection()`, which no
  // longer reads them (it now probes with an account-level
  // `ListBucketsCommand` instead of listing a named legacy bucket that dev
  // MinIO never provisioned) — the false "MinIO unreachable" health reading
  // this caused is the defect OD-8 closes.
  { namespace: 'platform', key: 'S3_PUBLIC_BUCKET' },
  { namespace: 'platform', key: 'S3_PRIVATE_BUCKET' },
];

/**
 * Idempotently soft-retire the superseded GlobalSetting rows across ALL
 * tenants: resourceStatus DELETED + updatedAt/updatedBy stamps + `_version`
 * increment. Already-DELETED rows are excluded, so re-runs write nothing.
 */
export const retireSupersededGlobalSettings = async (client: CorePrismaClient): Promise<{ retired: number }> => {
  console.log('Retiring superseded Global Settings ...');

  let retired = 0;
  for (const { namespace, key } of RETIRED_GLOBAL_SETTING_KEYS) {
    const result = await client.globalSetting.updateMany({
      where: { namespace, key, resourceStatus: { not: ResourceStatusType.DELETED } },
      data: {
        resourceStatus: ResourceStatusType.DELETED,
        resourceStatusUpdatedAt: new Date(),
        resourceStatusUpdatedBy: SYSTEM_USER_ID,
        version: { increment: 1 },
      },
    });
    if (result.count > 0) {
      console.log(`  Retired ${namespace}/${key} (${result.count} tenant rows)`);
    }
    retired += result.count;
  }

  console.log(`Retired ${retired} superseded Global Setting rows`);
  return { retired };
};

export const seedGlobalSetting = async (client: CorePrismaClient) => {
  console.log('Seeding per-tenant Global Settings (18 settings × 2 tenants)...');

  for (const s of ALL_SETTINGS) {
    await client.globalSetting.upsert({
      where: {
        GlobalSetting_tenantId_name_key_unique: {
          tenantId: s.tenantId,
          name: s.name,
          key: s.key,
        },
      },
      update: {
        // `value` is deliberately ABSENT. It is the operator's
        // choice; a re-seed runs on every Argo sync and would revert it. Only
        // code-owned metadata is refreshed here — the same contract the
        // PLATFORM_SETTINGS loop below already follows. `create` still supplies
        // the initial value.
        defaultValue: s.defaultValue,
        dataType: s.dataType,
        description: s.description,
        namespace: s.namespace,
        locked: s.locked ?? false,
      },
      create: {
        id: s.id,
        tenantId: s.tenantId,
        namespace: s.namespace,
        name: s.name,
        key: s.key,
        value: s.value,
        defaultValue: s.defaultValue,
        dataType: s.dataType,
        description: s.description,
        locked: s.locked ?? false,
        createdBy: CREATED_BY,
      },
    });
    console.log(`  [${s.tenantId.slice(-1)}] ${s.namespace}/${s.key}`);
  }

  console.log(`Seeded ${ALL_SETTINGS.length} Global Settings across all tenants`);

  // Platform-owned capability rows (SYSTEM_TENANT_ID). Idempotent:
  // refresh metadata but NEVER clobber an admin-tuned `value` on re-seed, so a
  // SUPER_ADMIN who turned the capability ON keeps it after `db:seed`.
  console.log(`Seeding platform Global Settings (${PLATFORM_SETTINGS.length} SYSTEM rows)...`);
  for (const s of PLATFORM_SETTINGS) {
    await client.globalSetting.upsert({
      where: {
        GlobalSetting_tenantId_name_key_unique: {
          tenantId: s.tenantId,
          name: s.name,
          key: s.key,
        },
      },
      update: {
        defaultValue: s.defaultValue,
        dataType: s.dataType,
        description: s.description,
        namespace: s.namespace,
        locked: s.locked ?? false,
      },
      create: {
        id: s.id,
        tenantId: s.tenantId,
        namespace: s.namespace,
        name: s.name,
        key: s.key,
        value: s.value,
        defaultValue: s.defaultValue,
        dataType: s.dataType,
        description: s.description,
        locked: s.locked ?? false,
        createdBy: CREATED_BY,
      },
    });
    console.log(`  [SYSTEM] ${s.namespace}/${s.key}`);
  }

  // Sweep the superseded text/guardrail keys AFTER the upserts so
  // existing DBs converge on the retired state (idempotent; see above).
  await retireSupersededGlobalSettings(client);
};
