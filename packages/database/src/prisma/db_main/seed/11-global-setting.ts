import type { CorePrismaClient } from '../../../client';
import { ValueType } from '../../../generated/core-prisma-client/client.js';
import {
    SEED_CUSTOMER_TENANT_IDS,
    SEED_TENANT_ID,
    SEED_USER_IDS,
    SEED_GLOBAL_SETTING_IDS,
    SYSTEM_TENANT_ID,
} from './00-constants';

/**
 * Per-Tenant Global Settings Seed Data
 *
 * Seeds general settings, feature flags, STT, SMR, and UX constants for
 * every tenant (Global + customer tenants) so the admin panel and SDK
 * always see populated configuration.
 *
 * Every tenant gets the same 19 settings (consolidated):
 *   - general       (3) — session limits, language, timeouts
 *   - feature-flags (6) — toggles for platform capabilities
 *   - stt           (2) — speech-to-text defaults
 *   - smr           (2) — summarisation provider / model defaults
 *   - ux-constants  (4) — static model lists for UI dropdowns
 *   - admin         (1) — locked config paths
 *   - arcaai-admin  (1) — admin-console menu order
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
// the same consolidated set of 19 settings.
// =============================================================================

const LOCAL_ASR_MODELS = JSON.stringify([
    { id: 'whisper-tiny',  name: 'Whisper Tiny',  size: '~75 MB'  },
    { id: 'whisper-base',  name: 'Whisper Base',  size: '~150 MB' },
    { id: 'whisper-small', name: 'Whisper Small', size: '~500 MB' },
]);

const LOCAL_VAD_MODELS = JSON.stringify([
    { id: 'silero-v5', name: 'Silero VAD v5' },
    { id: 'silero-v6', name: 'Silero VAD v6' },
]);

const LOCAL_NOISE_SUPPRESSION_MODELS = JSON.stringify([
    { id: 'rnnoise', name: 'RNNoise' },
]);

// =============================================================================
// SMR Provider-Model Catalog — available text-generation providers and models
//
// Seeded per-tenant so the admin UI can populate provider/model selectors.
// Admins pick a default provider + model from this catalog.
// =============================================================================

// LM Studio is the default/primary local engine; Ollama is optional/lower-priority.
export const SMR_PROVIDER_NAMES = ['lm-studio', 'ollama', 'azure-openai'] as const;

export const SMR_PROVIDER_MODELS = [
    {
        provider: 'lm-studio',
        models: [
            { name: 'google/gemma-4-e4b', size: '4.7 GB' },
            { name: 'lmstudio-community/gemma-4-E4B-it-QAT-GGUF', size: '4.7 GB' },
            { name: 'google/gemma-4-12b-qat', size: '8.1 GB' },
            { name: 'qwen3.5-4b', size: '3.1 GB' },
            { name: 'qwen3.5-0.8b', size: '0.95 GB' },
            { name: 'qwen/qwen3.5-9b', size: '6.1 GB' },
            { name: 'qwen/qwen3.5-35b-a3b', size: '20.6 GB' },
            { name: 'liquid/lfm2-24b-a2b', size: '12.5 GB' },
            { name: 'zai-org/glm-4.6v-flash', size: '6.6 GB' },
            { name: 'liquidai/lfm2.5-1.2b-instruct-mlx', size: '2.2 GB' },
            { name: 'lfm2.5-1.2b-thinking-mlx', size: '2.2 GB' },
            { name: 'liquidai/lfm2.5-vl-1.6b', size: '3.0 GB' },
            { name: 'translategemma-27b-it', size: '14.2 GB' },
            { name: 'mlx-community/medgemma-1.5-4b-it', size: '9.3 GB' },
            { name: 'unsloth/medgemma-1.5-4b-it', size: '8.8 GB' },
            { name: 'gpt-oss-20b', size: '12.3 GB' },
        ],
    },
    {
        provider: 'ollama',
        models: [
            { name: 'qwen3.5:27b', size: '17 GB' },
            { name: 'qwen3.5:latest', size: '6.6 GB' },
            { name: 'translategemma:12b', size: '8.1 GB' },
            { name: 'translategemma:latest', size: '3.3 GB' },
            { name: 'hf.co/unsloth/medgemma-27b-text-it-GGUF:Q4_K_M', size: '16 GB' },
            { name: 'gemma3:latest', size: '3.3 GB' },
            { name: 'gemma3n:e2b', size: '5.6 GB' },
            { name: 'gpt-oss:latest', size: '13 GB' },
            { name: 'gemma3n:latest', size: '7.5 GB' },
            { name: 'granite4:tiny-h', size: '4.2 GB' },
            { name: 'granite4:latest', size: '2.1 GB' },
        ],
    },
    {
        provider: 'azure-openai',
        models: [
            { name: 'gpt-4o-mini', size: '' },
        ],
    },
] as const;

const SMR_PROVIDER_MODELS_JSON = JSON.stringify(SMR_PROVIDER_MODELS);

// =============================================================================
// Admin Console Menu Order (TASK-331 doc-04 F4)
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
        smrProvider: string;
        smrModel: string;
        uxLocalAsrModels: string;
        uxLocalVadModels: string;
        uxLocalNoiseSuppressionModels: string;
        uxSmrProviderModels: string;
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
            value: 'whisper-large-v3',
            defaultValue: 'whisper-large-v3',
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

        // ── smr (2) ─────────────────────────────────────────────────────
        {
            id: ids.smrProvider,
            tenantId,
            namespace: 'smr',
            name: 'Default SMR Provider',
            key: 'default-smr-provider',
            value: 'lm-studio',
            defaultValue: 'lm-studio',
            dataType: ValueType.String,
            description: 'Default LLM provider for summarization (e.g., lm-studio, ollama, azure-openai)',
            locked: true,
        },
        {
            id: ids.smrModel,
            tenantId,
            namespace: 'smr',
            name: 'Default SMR Model',
            key: 'default-smr-model',
            value: 'google/gemma-4-e4b',
            defaultValue: 'google/gemma-4-e4b',
            dataType: ValueType.String,
            description: 'Default LLM model slug for summarization tasks (LM Studio model name)',
            locked: true,
        },

        // ── ux-constants (3) ────────────────────────────────────────────
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
        {
            id: ids.uxSmrProviderModels,
            tenantId,
            namespace: 'ux-constants',
            name: 'SMR Provider Models',
            key: 'smr-provider-models',
            value: SMR_PROVIDER_MODELS_JSON,
            defaultValue: SMR_PROVIDER_MODELS_JSON,
            dataType: ValueType.Json,
            description: 'Available text-generation providers and models for summarization (admin selects default from this catalog)',
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
        smrProvider: IDS.GLOBAL_SMR_PROVIDER,
        smrModel: IDS.GLOBAL_SMR_MODEL,
        uxLocalAsrModels: IDS.GLOBAL_UX_LOCAL_ASR_MODELS,
        uxLocalVadModels: IDS.GLOBAL_UX_LOCAL_VAD_MODELS,
        uxLocalNoiseSuppressionModels: IDS.GLOBAL_UX_LOCAL_NOISE_SUPPRESSION_MODELS,
        uxSmrProviderModels: IDS.GLOBAL_UX_SMR_PROVIDER_MODELS,
        lockedConfigPaths: IDS.GLOBAL_LOCKED_CONFIG_PATHS,
        adminMenuOrder: IDS.GLOBAL_ADMIN_MENU_ORDER,
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
        smrProvider: IDS.ARCAAI_SMR_PROVIDER,
        smrModel: IDS.ARCAAI_SMR_MODEL,
        uxLocalAsrModels: IDS.ARCAAI_UX_LOCAL_ASR_MODELS,
        uxLocalVadModels: IDS.ARCAAI_UX_LOCAL_VAD_MODELS,
        uxLocalNoiseSuppressionModels: IDS.ARCAAI_UX_LOCAL_NOISE_SUPPRESSION_MODELS,
        uxSmrProviderModels: IDS.ARCAAI_UX_SMR_PROVIDER_MODELS,
        lockedConfigPaths: IDS.ARCAAI_LOCKED_CONFIG_PATHS,
        adminMenuOrder: IDS.ARCAAI_ADMIN_MENU_ORDER,
    }),
    ...tenantSettings(SEED_CUSTOMER_TENANT_IDS.FOURBITS, {
        genMaxConcurrentSessions: IDS.FOURBITS_MAX_CONCURRENT_SESSIONS,
        genDefaultLanguage: IDS.FOURBITS_DEFAULT_LANGUAGE,
        genSessionTimeout: IDS.FOURBITS_SESSION_TIMEOUT,
        ffTranscription: IDS.FOURBITS_FF_TRANSCRIPTION,
        ffDnaStyle: IDS.FOURBITS_FF_DNA_STYLE,
        ffCrossChain: IDS.FOURBITS_FF_CROSS_CHAIN,
        ffNer: IDS.FOURBITS_FF_NER,
        ffCodeSwitching: IDS.FOURBITS_FF_CODE_SWITCHING,
        ffConsultationSharing: IDS.FOURBITS_FF_CONSULTATION_SHARING,
        sttModel: IDS.FOURBITS_STT_MODEL,
        sttVad: IDS.FOURBITS_STT_VAD,
        smrProvider: IDS.FOURBITS_SMR_PROVIDER,
        smrModel: IDS.FOURBITS_SMR_MODEL,
        uxLocalAsrModels: IDS.FOURBITS_UX_LOCAL_ASR_MODELS,
        uxLocalVadModels: IDS.FOURBITS_UX_LOCAL_VAD_MODELS,
        uxLocalNoiseSuppressionModels: IDS.FOURBITS_UX_LOCAL_NOISE_SUPPRESSION_MODELS,
        uxSmrProviderModels: IDS.FOURBITS_UX_SMR_PROVIDER_MODELS,
        lockedConfigPaths: IDS.FOURBITS_LOCKED_CONFIG_PATHS,
        adminMenuOrder: IDS.FOURBITS_ADMIN_MENU_ORDER,
    }),
    ...tenantSettings(SEED_CUSTOMER_TENANT_IDS.MUMBAI_HOSPITAL, {
        genMaxConcurrentSessions: IDS.MUMBAI_MAX_CONCURRENT_SESSIONS,
        genDefaultLanguage: IDS.MUMBAI_DEFAULT_LANGUAGE,
        genSessionTimeout: IDS.MUMBAI_SESSION_TIMEOUT,
        ffTranscription: IDS.MUMBAI_FF_TRANSCRIPTION,
        ffDnaStyle: IDS.MUMBAI_FF_DNA_STYLE,
        ffCrossChain: IDS.MUMBAI_FF_CROSS_CHAIN,
        ffNer: IDS.MUMBAI_FF_NER,
        ffCodeSwitching: IDS.MUMBAI_FF_CODE_SWITCHING,
        ffConsultationSharing: IDS.MUMBAI_FF_CONSULTATION_SHARING,
        sttModel: IDS.MUMBAI_STT_MODEL,
        sttVad: IDS.MUMBAI_STT_VAD,
        smrProvider: IDS.MUMBAI_SMR_PROVIDER,
        smrModel: IDS.MUMBAI_SMR_MODEL,
        uxLocalAsrModels: IDS.MUMBAI_UX_LOCAL_ASR_MODELS,
        uxLocalVadModels: IDS.MUMBAI_UX_LOCAL_VAD_MODELS,
        uxLocalNoiseSuppressionModels: IDS.MUMBAI_UX_LOCAL_NOISE_SUPPRESSION_MODELS,
        uxSmrProviderModels: IDS.MUMBAI_UX_SMR_PROVIDER_MODELS,
        lockedConfigPaths: IDS.MUMBAI_LOCKED_CONFIG_PATHS,
        adminMenuOrder: IDS.MUMBAI_ADMIN_MENU_ORDER,
    }),
];

// =============================================================================
// Platform-owned settings (SYSTEM_TENANT_ID)
//
// TASK-332 — the local raw-stream dual-capture capability is a PLATFORM gate,
// not a per-tenant flag: a single `locked` row owned by SYSTEM_TENANT_ID. The
// `AppSettingsService` cache is keyed flat by `key`, so one platform-scoped row
// resolves deterministically (the key is unique, so it never trips the
// boot-time duplicate-key invariant). Only SUPER_ADMIN can flip it
// (enforced by the `GlobalSettingService` locked write-guard). Default OFF.
// =============================================================================
const PLATFORM_SETTINGS: SettingDef[] = [
    {
        id: SEED_GLOBAL_SETTING_IDS.SYSTEM_FF_LOCAL_RAW_CAPTURE,
        tenantId: SYSTEM_TENANT_ID,
        namespace: 'feature-flags',
        name: 'Enable Local Raw Capture',
        key: 'enable-local-raw-capture',
        value: 'false',
        defaultValue: 'false',
        dataType: ValueType.Boolean,
        description:
            'Platform capability for local raw-stream dual-capture (TASK-332). The SDK-facing enablement is this AND the per-tenant TenantFrontendConfig.captureRawAudio toggle. Locked — only SUPER_ADMIN may change it.',
        locked: true,
    },
];

export const seedGlobalSetting = async (client: CorePrismaClient) => {
    console.log('Seeding per-tenant Global Settings (19 settings × 4 tenants)...');

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
                value: s.value,
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

    // TASK-332 — platform-owned capability rows (SYSTEM_TENANT_ID). Idempotent:
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
};
