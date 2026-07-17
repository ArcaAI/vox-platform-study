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
 * Audio / STT model catalog (TASK-506 consolidation, §4.1 keepers).
 *
 * Exactly the engines the 8-pipeline product matrix (TASK-505) references —
 * every row here is either referenced by a seeded pipeline `models:` block or
 * (ECAPA) inline-referenced as the diarization feature extractor. ids/slugs
 * are UNCHANGED from the pre-split `06-stt.ts` (update-in-place on re-seed);
 * TASK-506 backfills `provider`/`architecture`.
 */
export const AUDIO_AI_MODELS: AiModelSeed[] = [
    // =========================================================================
    // ASR Models (Automatic Speech Recognition)
    // =========================================================================
    {
        id: '80000000-0000-0000-0001-000000000003',
        tenantId: SYSTEM_TENANT_ID,
        name: 'Whisper Small',
        slug: 'whisper-small',
        description: 'OpenAI Whisper Small - Lightweight ASR model with 244M parameters',
        category: ModelCategory.AUDIO,
        taskType: ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
        modelType: ModelType.BASE_MODEL,
        source: AiModelSource.HUGGINGFACE,
        sourceUri: 'openai/whisper-small',
        sourceRevision: 'main',
        format: AiModelFormat.SAFETENSOR,
        provider: 'built-in',
        architecture: 'whisper',
        memorySizeMb: 1024, // ~1GB VRAM
        computeType: 'float16',
        tags: ['multilingual', 'lightweight', 'cpu-friendly'],
    },
    {
        id: '80000000-0000-0000-0001-000000000004',
        tenantId: SYSTEM_TENANT_ID,
        name: 'Whisper Large V3 Turbo',
        slug: 'whisper-large-v3-turbo',
        description: 'OpenAI Whisper Large V3 Turbo - Optimized for speed with 809M parameters',
        category: ModelCategory.AUDIO,
        taskType: ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
        modelType: ModelType.QUANTIZED_MODEL,
        source: AiModelSource.HUGGINGFACE,
        sourceUri: 'openai/whisper-large-v3-turbo',
        sourceRevision: 'main',
        format: AiModelFormat.SAFETENSOR,
        provider: 'built-in',
        architecture: 'whisper',
        memorySizeMb: 3584, // ~3.5GB VRAM
        computeType: 'float16',
        tags: ['multilingual', 'fast', 'recommended'],
    },
    {
        // TASK-356 Phase 2 / TASK-505 — faster-whisper whisper-large-v3-turbo,
        // CTranslate2 int8. D-4 resolved: points at the community deepdml
        // conversion (owner decision D3, 2026-07-16); loads via
        // FasterWhisperLoader at runtime.
        id: '80000000-0000-0000-0001-000000000007',
        tenantId: SYSTEM_TENANT_ID,
        name: 'Faster-Whisper Large V3 Turbo (CT2 int8)',
        slug: 'faster-whisper-large-v3-turbo-int8',
        description: 'whisper-large-v3-turbo converted to CTranslate2 and quantized int8 for faster-whisper (deepdml community conversion). Resolves by slug at runtime.',
        category: ModelCategory.AUDIO,
        taskType: ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
        modelType: ModelType.QUANTIZED_MODEL,
        source: AiModelSource.LOCAL,
        sourceUri: 'deepdml/faster-whisper-large-v3-turbo-ct2',
        sourceRevision: 'main',
        // TASK-505 review — FASTER_WHISPER (was CTRANSLATE2, which is the
        // legacy transformers-path alias and dispatched to the WRONG loader).
        format: AiModelFormat.FASTER_WHISPER,
        provider: 'built-in',
        architecture: 'whisper',
        memorySizeMb: 1700,
        computeType: 'int8',
        // TASK-361/505 — registered + catalog-visible; production/recommended
        // tags stay off until the CT2 pipeline earns the default via benchmarks.
        tags: ['multilingual', 'faster-whisper', 'ctranslate2', 'int8'],
    },
    {
        id: '80000000-0000-0000-0001-000000000010',
        tenantId: SYSTEM_TENANT_ID,
        name: 'Azure Speech STT',
        slug: 'azure-speech-stt',
        description: 'Azure Cognitive Services Speech-to-Text (cloud). Credentials via AZURE_SPEECH_KEY/AZURE_SPEECH_REGION settings.',
        category: ModelCategory.AUDIO,
        taskType: ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
        modelType: ModelType.BASE_MODEL,
        source: AiModelSource.LOCAL,
        sourceUri: 'azure://speech-to-text',
        sourceRevision: 'main',
        format: AiModelFormat.AZURE_SPEECH,
        provider: 'azure',
        architecture: null,
        memorySizeMb: 0,
        computeType: 'cloud',
        tags: ['cloud', 'azure', 'multilingual'],
    },
    {
        // Decision D4: PREVIEW service — engine disabled unless
        // AZURE_FOUNDRY_ENABLED; batch-only; no PHI until GA sign-off.
        id: '80000000-0000-0000-0001-000000000011',
        tenantId: SYSTEM_TENANT_ID,
        name: 'Azure MAI-Transcribe 1.5',
        slug: 'mai-transcribe-1.5',
        description: 'Microsoft MAI-Transcribe 1.5 via the Azure AI Foundry LLM Speech API (PREVIEW — no SLA, no diarization; batch-only per TASK-505 D4).',
        category: ModelCategory.AUDIO,
        taskType: ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
        modelType: ModelType.BASE_MODEL,
        source: AiModelSource.LOCAL,
        sourceUri: 'mai-transcribe-1.5',
        sourceRevision: 'main',
        format: AiModelFormat.AZURE_FOUNDRY,
        provider: 'azure',
        architecture: null,
        memorySizeMb: 0,
        computeType: 'cloud',
        tags: ['cloud', 'azure-foundry', 'preview', 'multilingual'],
    },
    {
        id: '80000000-0000-0000-0001-000000000012',
        tenantId: SYSTEM_TENANT_ID,
        name: 'Nemotron 3.5 ASR Streaming 0.6B (parakeet.cpp)',
        slug: 'nemotron-3.5-asr-streaming-0.6b',
        description: 'NVIDIA nemotron-3.5-asr-streaming-0.6b (cache-aware FastConformer-RNNT, 40 locales, OpenMDW-1.1) served by the parakeet.cpp ggml runtime. Weights: GGUF conversion via parakeet.cpp convert script.',
        category: ModelCategory.AUDIO,
        taskType: ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
        modelType: ModelType.QUANTIZED_MODEL,
        source: AiModelSource.HUGGINGFACE,
        sourceUri: 'nvidia/nemotron-3.5-asr-streaming-0.6b',
        sourceRevision: 'main',
        format: AiModelFormat.PARAKEET_CPP,
        provider: 'built-in',
        architecture: null,
        memorySizeMb: 800,
        computeType: 'q8_0',
        // TASK-505 review — the NVIDIA repo carries the raw .nemo checkpoint;
        // parakeet.cpp needs the GGUF conversion (convert script) staged first.
        tags: ['streaming', 'multilingual', 'ggml', 'parakeet.cpp', 'requires-conversion'],
    },

    // =========================================================================
    // VAD (Voice Activity Detection)
    // =========================================================================
    {
        id: '80000000-0000-0000-0002-000000000004',
        tenantId: SYSTEM_TENANT_ID,
        name: 'Silero VAD V6',
        slug: 'silero-vad-v6',
        description: 'Silero VAD V6 - Latest version with best accuracy and lowest latency. Recommended for production.',
        category: ModelCategory.AUDIO,
        taskType: ModelTaskType.VOICE_ACTIVITY_DETECTION,
        modelType: ModelType.BASE_MODEL,
        source: AiModelSource.HUGGINGFACE,
        sourceUri: 'snakers4/silero-vad',
        sourceRevision: 'v6.0',
        format: AiModelFormat.ONNX,
        provider: 'built-in',
        architecture: 'silero',
        memorySizeMb: 64,
        computeType: 'float32',
        tags: ['vad', 'lightweight', 'latest', 'recommended'],
    },

    // =========================================================================
    // Noise Reduction / Audio Enhancement
    // =========================================================================
    {
        id: '80000000-0000-0000-0003-000000000003',
        tenantId: SYSTEM_TENANT_ID,
        name: 'RNNoise',
        slug: 'rnnoise',
        description: 'RNNoise - Lightweight recurrent neural network noise suppression. Excellent for real-time applications with minimal CPU usage.',
        category: ModelCategory.AUDIO,
        taskType: ModelTaskType.AUDIO_TO_AUDIO,
        modelType: ModelType.BASE_MODEL,
        source: AiModelSource.HUGGINGFACE,
        sourceUri: 'nickolay/rnnoise',
        sourceRevision: 'main',
        format: AiModelFormat.ONNX,
        provider: 'built-in',
        architecture: null,
        memorySizeMb: 32,
        computeType: 'float32',
        tags: ['noise-reduction', 'real-time', 'lightweight', 'cpu-friendly'],
    },

    // =========================================================================
    // Diarization embedding (TASK-505 D1)
    // =========================================================================
    {
        // Decision D1: ECAPA-TDNN is the chosen diarization embedding
        // extractor. Catalog row is informational — pipelines reference the
        // embedding model INLINE (models.embedding slug resolution is not
        // implemented; see TASK-505 README). Cutover (vector(192) migration +
        // re-enrollment) is owner-scheduled — README Phase 4 runbook.
        id: '80000000-0000-0000-0001-000000000013',
        tenantId: SYSTEM_TENANT_ID,
        name: 'ECAPA-TDNN Speaker Embedding',
        slug: 'ecapa-tdnn-voxceleb',
        description: 'SpeechBrain ECAPA-TDNN speaker-verification embeddings (192-d, ~1.71% EER, Apache-2.0). TASK-505 D1 diarization feature extractor.',
        category: ModelCategory.AUDIO,
        taskType: ModelTaskType.SPEAKER_EMBEDDING,
        modelType: ModelType.BASE_MODEL,
        source: AiModelSource.HUGGINGFACE,
        sourceUri: 'speechbrain/spkrec-ecapa-voxceleb',
        sourceRevision: 'main',
        format: AiModelFormat.PYTORCH,
        provider: 'built-in',
        architecture: 'ecapa-tdnn',
        memorySizeMb: 96,
        computeType: 'float32',
        tags: ['diarization', 'speaker-embedding', 'ecapa'],
    },
];
