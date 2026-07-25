import { ResourceStatusType } from '../../../../generated/core-prisma-client/client.js';
import { SYSTEM_TENANT_ID } from '../00-constants';
import {
    AiModelFormat,
    AiModelSource,
    ModelCategory,
    ModelTaskType,
    ModelType,
    type AiModelSeed,
} from './shared';

/**
 * TTS engine catalog — the five engines with
 * their admin-selectable voice bindings in `metaData.voices`. The registry
 * becomes the platform TTS catalog (`TenantTtsConfig` stays the tenant knob
 * store); `seedAiModels` re-syncs `metaData` on re-seed so voice catalogs
 * stay current.
 *
 * `indic-f5` is seeded DISABLED — experimental, prod NO-GO.
 */
export const TTS_AI_MODELS: AiModelSeed[] = [
    {
        id: '80000000-0000-0000-0007-000000000012',
        tenantId: SYSTEM_TENANT_ID,
        name: 'Azure Neural Voices',
        slug: 'azure-neural-voices',
        description: 'Azure Cognitive Services neural TTS voices (cloud). Credentials via platform env/Vault or tenant BYO (TenantTtsProviderCredential).',
        category: ModelCategory.AUDIO,
        taskType: ModelTaskType.TEXT_TO_SPEECH,
        modelType: ModelType.BASE_MODEL,
        source: AiModelSource.LOCAL,
        sourceUri: 'azure://neural-voices',
        sourceRevision: 'main',
        format: AiModelFormat.AZURE_SPEECH,
        provider: 'azure',
        architecture: null,
        memorySizeMb: 0,
        computeType: 'cloud',
        tags: ['tts', 'cloud', 'azure'],
        metaData: {
            voices: [
                { id: 'en-IN-NeerjaNeural', locale: 'en-IN' },
                { id: 'en-IN-PrabhatNeural', locale: 'en-IN' },
                { id: 'ml-IN-SobhanaNeural', locale: 'ml-IN' },
                { id: 'ml-IN-MidhunNeural', locale: 'ml-IN' },
            ],
        },
    },
    {
        id: '80000000-0000-0000-0007-000000000013',
        tenantId: SYSTEM_TENANT_ID,
        name: 'Kokoro',
        slug: 'kokoro',
        description: 'hexgrad/Kokoro-82M — local PyTorch TTS engine, fast English synthesis on CPU. Weights managed internally by the `kokoro` package (KPipeline), not by this catalog row.',
        category: ModelCategory.AUDIO,
        taskType: ModelTaskType.TEXT_TO_SPEECH,
        modelType: ModelType.BASE_MODEL,
        source: AiModelSource.HUGGINGFACE,
        // Corrected to the real upstream repo + format: the
        // `kokoro` PyPI package (tts's actual runtime dependency) loads
        // PyTorch weights, not ONNX — `kokoro-onnx` is a different package
        // this service does not use.
        sourceUri: 'hexgrad/Kokoro-82M',
        sourceRevision: 'main',
        format: AiModelFormat.PYTORCH,
        provider: 'built-in',
        architecture: null,
        memorySizeMb: 512,
        computeType: 'float32',
        tags: ['tts', 'local'],
        metaData: {
            // tts internal provider name (catalog resolution: metaData.ttsProvider
            // → provider column (non built-in) → slug with '-'→'_').
            ttsProvider: 'kokoro',
            voices: [
                { id: 'af_heart', locale: 'en-US' },
                { id: 'am_adam', locale: 'en-US' },
            ],
        },
    },
    {
        id: '80000000-0000-0000-0007-000000000014',
        tenantId: SYSTEM_TENANT_ID,
        name: 'Sarvam Bulbul',
        slug: 'sarvam-bulbul',
        description: 'Sarvam Bulbul v3 cloud TTS — Indic-language synthesis (Malayalam). API key via platform env/Vault or tenant BYO.',
        category: ModelCategory.AUDIO,
        taskType: ModelTaskType.TEXT_TO_SPEECH,
        modelType: ModelType.BASE_MODEL,
        source: AiModelSource.LOCAL,
        sourceUri: 'bulbul:v3',
        sourceRevision: 'main',
        format: AiModelFormat.CLOUD_API,
        provider: 'sarvam',
        architecture: null,
        memorySizeMb: 0,
        computeType: 'cloud',
        tags: ['tts', 'cloud', 'sarvam'],
        metaData: {
            voices: [
                { id: 'ishita', locale: 'ml-IN' },
                { id: 'shubh', locale: 'ml-IN' },
            ],
        },
    },
    {
        id: '80000000-0000-0000-0007-000000000015',
        tenantId: SYSTEM_TENANT_ID,
        name: 'Indic Parler TTS',
        slug: 'indic-parler-tts',
        description: 'AI4Bharat Indic Parler-TTS — local Malayalam synthesis. Gated HuggingFace weights (operator mirror required, TASK-495).',
        category: ModelCategory.AUDIO,
        taskType: ModelTaskType.TEXT_TO_SPEECH,
        modelType: ModelType.BASE_MODEL,
        source: AiModelSource.HUGGINGFACE,
        sourceUri: 'ai4bharat/indic-parler-tts',
        sourceRevision: 'main',
        format: AiModelFormat.SAFETENSOR,
        provider: 'built-in',
        architecture: null,
        memorySizeMb: 4096,
        computeType: 'float16',
        tags: ['tts', 'local', 'gated'],
        metaData: {
            ttsProvider: 'indic_parler',
            voices: [{ id: 'Anjali', locale: 'ml-IN' }],
        },
    },
    {
        id: '80000000-0000-0000-0007-000000000016',
        tenantId: SYSTEM_TENANT_ID,
        name: 'IndicF5',
        slug: 'indic-f5',
        description: 'AI4Bharat IndicF5 — experimental Malayalam voice-cloning TTS. Prod NO-GO (TASK-494); seeded DISABLED.',
        category: ModelCategory.AUDIO,
        taskType: ModelTaskType.TEXT_TO_SPEECH,
        modelType: ModelType.BASE_MODEL,
        source: AiModelSource.HUGGINGFACE,
        sourceUri: 'ai4bharat/IndicF5',
        sourceRevision: 'main',
        format: AiModelFormat.SAFETENSOR,
        provider: 'built-in',
        architecture: null,
        memorySizeMb: 4096,
        computeType: 'float16',
        tags: ['tts', 'experimental', 'no-prod'],
        metaData: {
            ttsProvider: 'indic_f5',
            voices: [{ id: 'ml-ref-1', locale: 'ml-IN' }],
        },
        // Prod NO-GO — seeded disabled; admins may enable per env.
        resourceStatus: ResourceStatusType.DISABLED,
    },
];
