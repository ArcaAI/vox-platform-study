import type { CorePrismaClient } from '../../../client';
import { ResourceStatusType, ValueType } from '../../../generated/core-prisma-client/client.js';
import { SEED_CUSTOMER_TENANT_IDS, SEED_TENANT_ID, SEED_USER_IDS, SEED_GLOBAL_SETTING_IDS, SYSTEM_TENANT_ID, SYSTEM_USER_ID } from './00-constants';

/**
 * Per-Tenant Global Settings Seed Data
 *
 * Seeds general settings, feature flags, STT, TEXT, and UX constants for
 * every tenant (Global + customer tenants) so the admin panel and SDK
 * always see populated configuration.
 *
 * Every tenant gets the same 18 settings (consolidated):
 *   - general       (3) — session limits, language, timeouts
 *   - feature-flags (6) — toggles for platform capabilities
 *   - stt           (2) — speech-to-text defaults
 *   - text           (1) — Azure deployment name (non-secret)
 *   - ux-constants  (4) — static model lists + guardrail provider catalog
 *   - admin         (1) — locked config paths
 *   - arcaai-admin  (1) — admin-console menu order
 *
 * The text default-provider/default-model keys, the ad-hoc
 * `text-provider-models` UI catalog and the entire `guardrail` namespace are
 * RETIRED (superseded by the `AiTaskDefault` table + registry-backed provider
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
    ffTranscription: string;
    ffDnaStyle: string;
    ffCrossChain: string;
    ffNer: string;
    ffCodeSwitching: string;
    ffConsultationSharing: string;
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

    // ── feature-flags (6) ───────────────────────────────────────────
    {
      id: ids.ffTranscription,
      tenantId,
      namespace: 'feature-flags',
      name: 'Real-Time Transcription',
      key: 'enable-transcription',
      value: 'true',
      defaultValue: 'true',
      dataType: ValueType.Boolean,
      description: 'Enable real-time speech-to-text transcription during consultations',
      locked: true,
    },
    {
      id: ids.ffDnaStyle,
      tenantId,
      namespace: 'feature-flags',
      name: 'DNA Writing Style',
      key: 'enable-dna-style',
      value: 'true',
      defaultValue: 'true',
      dataType: ValueType.Boolean,
      description: 'Enable DNA-based writing style analysis and personalised summaries',
      locked: true,
    },
    {
      id: ids.ffCrossChain,
      tenantId,
      namespace: 'feature-flags',
      name: 'Cross-Chain Summary',
      key: 'enable-cross-chain-summary',
      value: 'false',
      defaultValue: 'false',
      dataType: ValueType.Boolean,
      description: 'Enable cross-chain summary generation across multiple consultations',
      locked: true,
    },
    {
      id: ids.ffNer,
      tenantId,
      namespace: 'feature-flags',
      name: 'NER Extraction',
      key: 'enable-ner-extraction',
      value: 'true',
      defaultValue: 'true',
      dataType: ValueType.Boolean,
      description: 'Enable named-entity recognition extraction from transcripts',
      locked: true,
    },
    {
      id: ids.ffCodeSwitching,
      tenantId,
      namespace: 'feature-flags',
      name: 'Code Switching',
      key: 'enable-code-switching',
      value: 'false',
      defaultValue: 'false',
      dataType: ValueType.Boolean,
      description: 'Enable multi-language code-switching detection in transcription',
      locked: true,
    },
    {
      id: ids.ffConsultationSharing,
      tenantId,
      namespace: 'feature-flags',
      name: 'Consultation Sharing',
      key: 'enable-consultation-sharing',
      value: 'true',
      defaultValue: 'true',
      dataType: ValueType.Boolean,
      description: 'Enable cross-doctor read-only access to consultations for shared patients (continuity of care)',
    },

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
    // by the AiTaskDefault table (`guardrail.validate` key, GLOBAL-ADMIN-
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
    ffTranscription: IDS.GLOBAL_FF_TRANSCRIPTION,
    ffDnaStyle: IDS.GLOBAL_FF_DNA_STYLE,
    ffCrossChain: IDS.GLOBAL_FF_CROSS_CHAIN,
    ffNer: IDS.GLOBAL_FF_NER,
    ffCodeSwitching: IDS.GLOBAL_FF_CODE_SWITCHING,
    ffConsultationSharing: IDS.GLOBAL_FF_CONSULTATION_SHARING,
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
    ffTranscription: IDS.ARCAAI_FF_TRANSCRIPTION,
    ffDnaStyle: IDS.ARCAAI_FF_DNA_STYLE,
    ffCrossChain: IDS.ARCAAI_FF_CROSS_CHAIN,
    ffNer: IDS.ARCAAI_FF_NER,
    ffCodeSwitching: IDS.ARCAAI_FF_CODE_SWITCHING,
    ffConsultationSharing: IDS.ARCAAI_FF_CONSULTATION_SHARING,
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
// not a per-tenant flag: a single `locked` row owned by SYSTEM_TENANT_ID. The
// `AppSettingsService` cache is keyed flat by `key`, so one platform-scoped row
// resolves deterministically (the key is unique, so it never trips the
// boot-time duplicate-key invariant). Only SUPER_ADMIN can flip it
// (enforced by the `GlobalSettingService` locked write-guard). Default OFF.
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
    // `defaultValue` stays 'false' so a reset reverts to the locked default.
    value: 'true',
    defaultValue: 'false',
    dataType: ValueType.Boolean,
    description:
      'Platform capability for local raw-stream dual-capture . The SDK-facing enablement is this AND the per-tenant TenantFrontendConfig.captureRawAudio toggle. Locked — only SUPER_ADMIN may change it.',
    locked: true,
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
];

// =============================================================================
// Superseded GlobalSetting keys (soft-retire sweep)
//
// These six keys are replaced by the AiTaskDefault table + registry-backed
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
