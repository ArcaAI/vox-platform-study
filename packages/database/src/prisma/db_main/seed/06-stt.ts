import type { CorePrismaClient } from '../../../client';
import { ValueType } from '../../../generated/core-prisma-client/client.js';
import { SYSTEM_TENANT_ID, SEED_TENANT_ID, SEED_CUSTOMER_TENANT_IDS } from './00-constants';
import { TEMPLATE_IDS } from './07-prompt-template';

/**
 * STT (Speech-to-Text) Seed Data
 *
 * This script creates seed data for the STT service including:
 * - AI Models (ASR, VAD, Noise Reduction)
 * - ASR Pipelines
 * - Global Settings for STT configuration
 *
 * These rows are PLATFORM-WIDE system seeds: every customer tenant inherits
 * them; they are NOT customer data. Therefore they are owned by the reserved
 * system tenant (`00000000-…`), introduced by TASK-305 Phase A.
 *
 * See: docs/implementation/STT-001-STT-Service-V2-Architecture/README.md
 * See: docs/implementation/STT-002-Domain-Layer-Implementation/README.md
 */

// `DEFAULT_TENANT_ID` is kept as a local re-export so existing call sites
// (e.g. internal helpers, tests) still compile, but the value now points at
// the reserved system tenant.
export const DEFAULT_TENANT_ID = SYSTEM_TENANT_ID;
export { SYSTEM_USER_ID } from './00-constants';

// =============================================================================
// ENUMS (matching Prisma enums)
// =============================================================================

export const AiModelSource = {
    HUGGINGFACE: 'HUGGINGFACE',
    GITHUB: 'GITHUB',
    MLFLOW: 'MLFLOW',
    LOCAL: 'LOCAL',
} as const;

export const AiModelFormat = {
    SAFETENSOR: 'SAFETENSOR',
    ONNX: 'ONNX',
    NEMO: 'NEMO',
    PYTORCH: 'PYTORCH',
    // TASK-356 Phase 1 — additive formats (foundation migration). Only the
    // values actually used by a seed row are mirrored here.
    MLX: 'MLX',
    GGUF: 'GGUF',
} as const;

export const ModelCategory = {
    AUDIO: 'AUDIO',
    NLP: 'NLP',
} as const;

export const ModelTaskType = {
    AUTOMATIC_SPEECH_RECOGNITION: 'AUTOMATIC_SPEECH_RECOGNITION',
    VOICE_ACTIVITY_DETECTION: 'VOICE_ACTIVITY_DETECTION',
    AUDIO_TO_AUDIO: 'AUDIO_TO_AUDIO',
    SUMMARIZATION: 'SUMMARIZATION',
    TEXT_GENERATION: 'TEXT_GENERATION',
    // TASK-356 Phase 1 — guardrail/safety models (foundation migration).
    GUARDRAIL: 'GUARDRAIL',
} as const;

export const ModelType = {
    BASE_MODEL: 'BASE_MODEL',
    FINETUNED_MODEL: 'FINETUNED_MODEL',
    QUANTIZED_MODEL: 'QUANTIZED_MODEL',
} as const;

// =============================================================================
// AI MODELS SEED DATA
// =============================================================================

export const DEFAULT_AI_MODELS = [
    // =========================================================================
    // ASR Models (Automatic Speech Recognition)
    // =========================================================================
    {
        id: '80000000-0000-0000-0001-000000000001',
        tenantId: DEFAULT_TENANT_ID,
        name: 'Whisper Large V3',
        slug: 'whisper-large-v3',
        description: 'OpenAI Whisper Large V3 - State-of-the-art multilingual ASR model with 1.5B parameters',
        category: ModelCategory.AUDIO,
        taskType: ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
        modelType: ModelType.BASE_MODEL,
        source: AiModelSource.HUGGINGFACE,
        sourceUri: 'openai/whisper-large-v3',
        sourceRevision: 'main',
        format: AiModelFormat.SAFETENSOR,
        memorySizeMb: 6144, // ~6GB VRAM
        computeType: 'float16',
        tags: ['multilingual', 'production', 'recommended'],
    },
    {
        id: '80000000-0000-0000-0001-000000000002',
        tenantId: DEFAULT_TENANT_ID,
        name: 'Whisper Medium',
        slug: 'whisper-medium',
        description: 'OpenAI Whisper Medium - Balanced ASR model with 769M parameters',
        category: ModelCategory.AUDIO,
        taskType: ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
        modelType: ModelType.BASE_MODEL,
        source: AiModelSource.HUGGINGFACE,
        sourceUri: 'openai/whisper-medium',
        sourceRevision: 'main',
        format: AiModelFormat.SAFETENSOR,
        memorySizeMb: 3072, // ~3GB VRAM
        computeType: 'float16',
        tags: ['multilingual', 'balanced'],
    },
    {
        id: '80000000-0000-0000-0001-000000000003',
        tenantId: DEFAULT_TENANT_ID,
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
        memorySizeMb: 1024, // ~1GB VRAM
        computeType: 'float16',
        tags: ['multilingual', 'lightweight', 'cpu-friendly'],
    },
    {
        id: '80000000-0000-0000-0001-000000000004',
        tenantId: DEFAULT_TENANT_ID,
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
        memorySizeMb: 3584, // ~3.5GB VRAM
        computeType: 'float16',
        tags: ['multilingual', 'fast', 'recommended'],
    },
    {
        id: '80000000-0000-0000-0001-000000000005',
        tenantId: DEFAULT_TENANT_ID,
        name: 'Faster Whisper Large V3 (ONNX)',
        slug: 'faster-whisper-large-v3',
        description: 'Faster Whisper Large V3 - CTranslate2 optimized ONNX version for 4x faster inference',
        category: ModelCategory.AUDIO,
        taskType: ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
        modelType: ModelType.QUANTIZED_MODEL,
        source: AiModelSource.HUGGINGFACE,
        sourceUri: 'Systran/faster-whisper-large-v3',
        sourceRevision: 'main',
        format: AiModelFormat.ONNX,
        memorySizeMb: 3072,
        computeType: 'float16',
        tags: ['multilingual', 'optimized', 'fast'],
    },
    {
        id: '80000000-0000-0000-0001-000000000006',
        tenantId: DEFAULT_TENANT_ID,
        name: 'NVIDIA Parakeet CTC 1.1B',
        slug: 'parakeet-ctc-1.1b',
        description: 'NVIDIA Parakeet CTC 1.1B - High-quality English ASR with NeMo framework',
        category: ModelCategory.AUDIO,
        taskType: ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
        modelType: ModelType.BASE_MODEL,
        source: AiModelSource.HUGGINGFACE,
        sourceUri: 'nvidia/parakeet-ctc-1.1b',
        sourceRevision: 'main',
        format: AiModelFormat.NEMO,
        memorySizeMb: 4096,
        computeType: 'float16',
        tags: ['english-only', 'nemo', 'high-quality'],
    },

    // =========================================================================
    // VAD Models (Voice Activity Detection)
    // =========================================================================
    {
        id: '80000000-0000-0000-0002-000000000001',
        tenantId: DEFAULT_TENANT_ID,
        name: 'Silero VAD V4',
        slug: 'silero-vad-v4',
        description: 'Silero VAD V4 - Fast and accurate voice activity detection model',
        category: ModelCategory.AUDIO,
        taskType: ModelTaskType.VOICE_ACTIVITY_DETECTION,
        modelType: ModelType.BASE_MODEL,
        source: AiModelSource.HUGGINGFACE,
        sourceUri: 'snakers4/silero-vad',
        sourceRevision: 'v4.0',
        format: AiModelFormat.ONNX,
        memorySizeMb: 64,
        computeType: 'float32',
        tags: ['vad', 'lightweight', 'recommended'],
    },
    {
        id: '80000000-0000-0000-0002-000000000002',
        tenantId: DEFAULT_TENANT_ID,
        name: 'Silero VAD V5',
        slug: 'silero-vad-v5',
        description: 'Silero VAD V5 - Improved accuracy over V4',
        category: ModelCategory.AUDIO,
        taskType: ModelTaskType.VOICE_ACTIVITY_DETECTION,
        modelType: ModelType.BASE_MODEL,
        source: AiModelSource.HUGGINGFACE,
        sourceUri: 'snakers4/silero-vad',
        sourceRevision: 'v5.0',
        format: AiModelFormat.ONNX,
        memorySizeMb: 64,
        computeType: 'float32',
        tags: ['vad', 'lightweight'],
    },
    {
        id: '80000000-0000-0000-0002-000000000004',
        tenantId: DEFAULT_TENANT_ID,
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
        memorySizeMb: 64,
        computeType: 'float32',
        tags: ['vad', 'lightweight', 'latest', 'recommended'],
    },
    {
        id: '80000000-0000-0000-0002-000000000003',
        tenantId: DEFAULT_TENANT_ID,
        name: 'PyAnnote Voice Activity Detection',
        slug: 'pyannote-vad',
        description: 'PyAnnote VAD - Neural network based VAD for speaker diarization pipelines',
        category: ModelCategory.AUDIO,
        taskType: ModelTaskType.VOICE_ACTIVITY_DETECTION,
        modelType: ModelType.BASE_MODEL,
        source: AiModelSource.HUGGINGFACE,
        sourceUri: 'pyannote/voice-activity-detection',
        sourceRevision: 'main',
        format: AiModelFormat.PYTORCH,
        memorySizeMb: 256,
        computeType: 'float32',
        tags: ['vad', 'diarization', 'pyannote'],
    },

    // =========================================================================
    // Noise Reduction / Audio Enhancement Models
    // =========================================================================
    {
        id: '80000000-0000-0000-0003-000000000001',
        tenantId: DEFAULT_TENANT_ID,
        name: 'DeepFilterNet V3',
        slug: 'deepfilternet-v3',
        description: 'DeepFilterNet V3 - Real-time noise suppression and speech enhancement',
        category: ModelCategory.AUDIO,
        taskType: ModelTaskType.AUDIO_TO_AUDIO,
        modelType: ModelType.BASE_MODEL,
        source: AiModelSource.HUGGINGFACE,
        sourceUri: 'Rikorose/DeepFilterNet3',
        sourceRevision: 'main',
        format: AiModelFormat.ONNX,
        memorySizeMb: 128,
        computeType: 'float32',
        tags: ['noise-reduction', 'real-time', 'recommended'],
    },
    {
        id: '80000000-0000-0000-0003-000000000003',
        tenantId: DEFAULT_TENANT_ID,
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
        memorySizeMb: 32,
        computeType: 'float32',
        tags: ['noise-reduction', 'real-time', 'lightweight', 'cpu-friendly'],
    },
    {
        id: '80000000-0000-0000-0003-000000000002',
        tenantId: DEFAULT_TENANT_ID,
        name: 'NVIDIA CleanUNet',
        slug: 'nvidia-cleanunet',
        description: 'NVIDIA CleanUNet - High-quality speech enhancement for noisy environments',
        category: ModelCategory.AUDIO,
        taskType: ModelTaskType.AUDIO_TO_AUDIO,
        modelType: ModelType.BASE_MODEL,
        source: AiModelSource.HUGGINGFACE,
        sourceUri: 'nvidia/CleanUNet',
        sourceRevision: 'main',
        format: AiModelFormat.PYTORCH,
        memorySizeMb: 512,
        computeType: 'float16',
        tags: ['noise-reduction', 'high-quality'],
    },

    // =========================================================================
    // ONNX-Community Whisper Models (Optimized ONNX versions)
    // =========================================================================
    {
        id: '80000000-0000-0000-0004-000000000001',
        tenantId: DEFAULT_TENANT_ID,
        name: 'Whisper Large V3 Turbo (ONNX)',
        slug: 'whisper-large-v3-turbo-onnx',
        description: 'ONNX-community Whisper Large V3 Turbo - Optimized ONNX version for fast inference with HuggingFace Optimum',
        category: ModelCategory.AUDIO,
        taskType: ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
        modelType: ModelType.QUANTIZED_MODEL,
        source: AiModelSource.HUGGINGFACE,
        sourceUri: 'onnx-community/whisper-large-v3-turbo',
        sourceRevision: 'main',
        format: AiModelFormat.ONNX,
        memorySizeMb: 1600,
        computeType: 'float16',
        tags: ['multilingual', 'fast', 'onnx', 'optimum', 'recommended'],
    },
    {
        id: '80000000-0000-0000-0004-000000000002',
        tenantId: DEFAULT_TENANT_ID,
        name: 'Whisper Large V3 (ONNX)',
        slug: 'whisper-large-v3-onnx',
        description: 'ONNX-community Whisper Large V3 - Full ONNX version for production transcription',
        category: ModelCategory.AUDIO,
        taskType: ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
        modelType: ModelType.QUANTIZED_MODEL,
        source: AiModelSource.HUGGINGFACE,
        sourceUri: 'onnx-community/whisper-large-v3',
        sourceRevision: 'main',
        format: AiModelFormat.ONNX,
        memorySizeMb: 3072,
        computeType: 'float16',
        tags: ['multilingual', 'production', 'onnx', 'optimum'],
    },
    {
        id: '80000000-0000-0000-0004-000000000003',
        tenantId: DEFAULT_TENANT_ID,
        name: 'Whisper Medium (ONNX)',
        slug: 'whisper-medium-onnx',
        description: 'ONNX-community Whisper Medium - Balanced ONNX version for good speed/quality tradeoff',
        category: ModelCategory.AUDIO,
        taskType: ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
        modelType: ModelType.QUANTIZED_MODEL,
        source: AiModelSource.HUGGINGFACE,
        sourceUri: 'onnx-community/whisper-medium',
        sourceRevision: 'main',
        format: AiModelFormat.ONNX,
        memorySizeMb: 1536,
        computeType: 'float16',
        tags: ['multilingual', 'balanced', 'onnx', 'optimum'],
    },
    {
        id: '80000000-0000-0000-0004-000000000004',
        tenantId: DEFAULT_TENANT_ID,
        name: 'Whisper Small (ONNX)',
        slug: 'whisper-small-onnx',
        description: 'ONNX-community Whisper Small - Lightweight ONNX version for CPU inference',
        category: ModelCategory.AUDIO,
        taskType: ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
        modelType: ModelType.QUANTIZED_MODEL,
        source: AiModelSource.HUGGINGFACE,
        sourceUri: 'onnx-community/whisper-small',
        sourceRevision: 'main',
        format: AiModelFormat.ONNX,
        memorySizeMb: 512,
        computeType: 'float32',
        tags: ['multilingual', 'lightweight', 'onnx', 'cpu-friendly'],
    },

    // =========================================================================
    // LLM / Summarization Models (SMR v2 Providers)
    // =========================================================================

    // --- Ollama Provider Models (11 models) ---
    {
        id: '80000000-0000-0000-0005-000000000001',
        tenantId: DEFAULT_TENANT_ID,
        name: 'Qwen 3.5 27B',
        slug: 'ollama-qwen3.5-27b',
        description: 'Qwen 3.5 27B via Ollama — large reasoning model for complex summarization',
        category: ModelCategory.NLP,
        taskType: ModelTaskType.TEXT_GENERATION,
        modelType: ModelType.BASE_MODEL,
        source: AiModelSource.LOCAL,
        sourceUri: 'qwen3.5:27b',
        sourceRevision: 'main',
        format: AiModelFormat.SAFETENSOR,
        memorySizeMb: 17408,
        computeType: 'quantized',
        tags: ['smr', 'ollama', 'multilingual', 'high-quality'],
    },
    {
        id: '80000000-0000-0000-0005-000000000002',
        tenantId: DEFAULT_TENANT_ID,
        name: 'Qwen 3.5 Latest',
        slug: 'ollama-qwen3.5-latest',
        description: 'Qwen 3.5 latest via Ollama — balanced reasoning model',
        category: ModelCategory.NLP,
        taskType: ModelTaskType.TEXT_GENERATION,
        modelType: ModelType.BASE_MODEL,
        source: AiModelSource.LOCAL,
        sourceUri: 'qwen3.5:latest',
        sourceRevision: 'main',
        format: AiModelFormat.SAFETENSOR,
        memorySizeMb: 6758,
        computeType: 'quantized',
        tags: ['smr', 'ollama', 'multilingual', 'balanced'],
    },
    {
        id: '80000000-0000-0000-0005-000000000003',
        tenantId: DEFAULT_TENANT_ID,
        name: 'TranslateGemma 12B',
        slug: 'ollama-translategemma-12b',
        description: 'Google TranslateGemma 12B via Ollama — translation-focused model',
        category: ModelCategory.NLP,
        taskType: ModelTaskType.TEXT_GENERATION,
        modelType: ModelType.BASE_MODEL,
        source: AiModelSource.LOCAL,
        sourceUri: 'translategemma:12b',
        sourceRevision: 'main',
        format: AiModelFormat.SAFETENSOR,
        memorySizeMb: 8294,
        computeType: 'quantized',
        tags: ['smr', 'ollama', 'translation', 'multilingual'],
    },
    {
        id: '80000000-0000-0000-0005-000000000004',
        tenantId: DEFAULT_TENANT_ID,
        name: 'TranslateGemma Latest',
        slug: 'ollama-translategemma-latest',
        description: 'Google TranslateGemma latest via Ollama — lightweight translation model',
        category: ModelCategory.NLP,
        taskType: ModelTaskType.TEXT_GENERATION,
        modelType: ModelType.BASE_MODEL,
        source: AiModelSource.LOCAL,
        sourceUri: 'translategemma:latest',
        sourceRevision: 'main',
        format: AiModelFormat.SAFETENSOR,
        memorySizeMb: 3379,
        computeType: 'quantized',
        tags: ['smr', 'ollama', 'translation', 'lightweight'],
    },
    {
        id: '80000000-0000-0000-0005-000000000005',
        tenantId: DEFAULT_TENANT_ID,
        name: 'MedGemma 27B Text Q4_K_M',
        slug: 'ollama-medgemma-27b-text-q4km',
        description: 'MedGemma 27B text-it GGUF Q4_K_M via Ollama — medical-domain text generation',
        category: ModelCategory.NLP,
        taskType: ModelTaskType.SUMMARIZATION,
        modelType: ModelType.QUANTIZED_MODEL,
        source: AiModelSource.LOCAL,
        sourceUri: 'hf.co/unsloth/medgemma-27b-text-it-GGUF:Q4_K_M',
        sourceRevision: 'main',
        format: AiModelFormat.SAFETENSOR,
        memorySizeMb: 16384,
        computeType: 'quantized',
        tags: ['smr', 'ollama', 'medical', 'high-quality', 'recommended'],
    },
    {
        id: '80000000-0000-0000-0005-000000000006',
        tenantId: DEFAULT_TENANT_ID,
        name: 'Gemma 3 Latest',
        slug: 'ollama-gemma3-latest',
        description: 'Google Gemma 3 latest via Ollama — compact general-purpose model',
        category: ModelCategory.NLP,
        taskType: ModelTaskType.TEXT_GENERATION,
        modelType: ModelType.BASE_MODEL,
        source: AiModelSource.LOCAL,
        sourceUri: 'gemma3:latest',
        sourceRevision: 'main',
        format: AiModelFormat.SAFETENSOR,
        memorySizeMb: 3379,
        computeType: 'quantized',
        tags: ['smr', 'ollama', 'lightweight', 'fast'],
    },
    {
        id: '80000000-0000-0000-0005-000000000007',
        tenantId: DEFAULT_TENANT_ID,
        name: 'Gemma 3n E2B',
        slug: 'ollama-gemma3n-e2b',
        description: 'Google Gemma 3n E2B via Ollama — edge-optimized model',
        category: ModelCategory.NLP,
        taskType: ModelTaskType.TEXT_GENERATION,
        modelType: ModelType.BASE_MODEL,
        source: AiModelSource.LOCAL,
        sourceUri: 'gemma3n:e2b',
        sourceRevision: 'main',
        format: AiModelFormat.SAFETENSOR,
        memorySizeMb: 5734,
        computeType: 'quantized',
        tags: ['smr', 'ollama', 'edge', 'balanced'],
    },
    {
        id: '80000000-0000-0000-0005-000000000008',
        tenantId: DEFAULT_TENANT_ID,
        name: 'GPT-OSS Latest',
        slug: 'ollama-gpt-oss-latest',
        description: 'GPT-OSS latest via Ollama — open-source GPT-class model',
        category: ModelCategory.NLP,
        taskType: ModelTaskType.TEXT_GENERATION,
        modelType: ModelType.BASE_MODEL,
        source: AiModelSource.LOCAL,
        sourceUri: 'gpt-oss:latest',
        sourceRevision: 'main',
        format: AiModelFormat.SAFETENSOR,
        memorySizeMb: 13312,
        computeType: 'quantized',
        tags: ['smr', 'ollama', 'high-quality'],
    },
    {
        id: '80000000-0000-0000-0005-000000000009',
        tenantId: DEFAULT_TENANT_ID,
        name: 'Gemma 3n Latest',
        slug: 'ollama-gemma3n-latest',
        description: 'Google Gemma 3n latest via Ollama — next-gen edge model',
        category: ModelCategory.NLP,
        taskType: ModelTaskType.TEXT_GENERATION,
        modelType: ModelType.BASE_MODEL,
        source: AiModelSource.LOCAL,
        sourceUri: 'gemma3n:latest',
        sourceRevision: 'main',
        format: AiModelFormat.SAFETENSOR,
        memorySizeMb: 7680,
        computeType: 'quantized',
        tags: ['smr', 'ollama', 'edge', 'balanced'],
    },
    {
        id: '80000000-0000-0000-0005-000000000010',
        tenantId: DEFAULT_TENANT_ID,
        name: 'Granite 4 Tiny-H',
        slug: 'ollama-granite4-tiny-h',
        description: 'IBM Granite 4 Tiny-H via Ollama — compact enterprise model',
        category: ModelCategory.NLP,
        taskType: ModelTaskType.TEXT_GENERATION,
        modelType: ModelType.BASE_MODEL,
        source: AiModelSource.LOCAL,
        sourceUri: 'granite4:tiny-h',
        sourceRevision: 'main',
        format: AiModelFormat.SAFETENSOR,
        memorySizeMb: 4301,
        computeType: 'quantized',
        tags: ['smr', 'ollama', 'enterprise', 'balanced'],
    },
    {
        id: '80000000-0000-0000-0005-000000000011',
        tenantId: DEFAULT_TENANT_ID,
        name: 'Granite 4 Latest',
        slug: 'ollama-granite4-latest',
        description: 'IBM Granite 4 latest via Ollama — smallest enterprise model, ideal for testing',
        category: ModelCategory.NLP,
        taskType: ModelTaskType.TEXT_GENERATION,
        modelType: ModelType.BASE_MODEL,
        source: AiModelSource.LOCAL,
        sourceUri: 'granite4:latest',
        sourceRevision: 'main',
        format: AiModelFormat.SAFETENSOR,
        memorySizeMb: 2150,
        computeType: 'quantized',
        tags: ['smr', 'ollama', 'enterprise', 'lightweight', 'fast', 'default'],
    },

    // --- Azure OpenAI Provider Models ---
    {
        id: '80000000-0000-0000-0005-000000000015',
        tenantId: DEFAULT_TENANT_ID,
        name: 'GPT-4',
        slug: 'gpt-4',
        description: 'OpenAI GPT-4 via Azure — high-quality summarization with strong medical reasoning',
        category: ModelCategory.NLP,
        taskType: ModelTaskType.SUMMARIZATION,
        modelType: ModelType.BASE_MODEL,
        source: AiModelSource.HUGGINGFACE,
        sourceUri: 'azure/gpt-4',
        sourceRevision: 'main',
        format: AiModelFormat.SAFETENSOR,
        memorySizeMb: 0,
        computeType: 'cloud',
        tags: ['smr', 'azure-openai', 'default', 'cloud', 'high-quality', 'recommended'],
    },
    {
        id: '80000000-0000-0000-0005-000000000016',
        tenantId: DEFAULT_TENANT_ID,
        name: 'GPT-4o',
        slug: 'gpt-4o',
        description: 'OpenAI GPT-4o via Azure — multimodal model optimized for speed and cost',
        category: ModelCategory.NLP,
        taskType: ModelTaskType.SUMMARIZATION,
        modelType: ModelType.BASE_MODEL,
        source: AiModelSource.HUGGINGFACE,
        sourceUri: 'azure/gpt-4o',
        sourceRevision: 'main',
        format: AiModelFormat.SAFETENSOR,
        memorySizeMb: 0,
        computeType: 'cloud',
        tags: ['smr', 'azure-openai', 'cloud', 'fast', 'multimodal'],
    },
    {
        id: '80000000-0000-0000-0005-000000000017',
        tenantId: DEFAULT_TENANT_ID,
        name: 'GPT-4o Mini',
        slug: 'gpt-4o-mini',
        description: 'OpenAI GPT-4o Mini via Azure — cost-effective model for routine summarization',
        category: ModelCategory.NLP,
        taskType: ModelTaskType.SUMMARIZATION,
        modelType: ModelType.BASE_MODEL,
        source: AiModelSource.HUGGINGFACE,
        sourceUri: 'azure/gpt-4o-mini',
        sourceRevision: 'main',
        format: AiModelFormat.SAFETENSOR,
        memorySizeMb: 0,
        computeType: 'cloud',
        tags: ['smr', 'azure-openai', 'cloud', 'fast', 'cost-effective'],
    },

    // --- AWS Bedrock Provider Models ---
    {
        id: '80000000-0000-0000-0005-000000000020',
        tenantId: DEFAULT_TENANT_ID,
        name: 'Claude 3 Haiku',
        slug: 'claude-3-haiku',
        description: 'Anthropic Claude 3 Haiku via Bedrock — fast, cost-effective summarization',
        category: ModelCategory.NLP,
        taskType: ModelTaskType.SUMMARIZATION,
        modelType: ModelType.BASE_MODEL,
        source: AiModelSource.HUGGINGFACE,
        sourceUri: 'anthropic/claude-3-haiku-20240307-v1:0',
        sourceRevision: 'main',
        format: AiModelFormat.SAFETENSOR,
        memorySizeMb: 0,
        computeType: 'cloud',
        tags: ['smr', 'bedrock', 'default', 'cloud', 'fast', 'cost-effective'],
    },
    {
        id: '80000000-0000-0000-0005-000000000021',
        tenantId: DEFAULT_TENANT_ID,
        name: 'Claude 3.5 Sonnet',
        slug: 'claude-3.5-sonnet',
        description: 'Anthropic Claude 3.5 Sonnet via Bedrock — balanced quality and speed for medical summarization',
        category: ModelCategory.NLP,
        taskType: ModelTaskType.SUMMARIZATION,
        modelType: ModelType.BASE_MODEL,
        source: AiModelSource.HUGGINGFACE,
        sourceUri: 'anthropic/claude-3-5-sonnet-20241022-v2:0',
        sourceRevision: 'main',
        format: AiModelFormat.SAFETENSOR,
        memorySizeMb: 0,
        computeType: 'cloud',
        tags: ['smr', 'bedrock', 'cloud', 'high-quality', 'recommended'],
    },

    // --- OpenAI-Compatible Provider Models ---
    {
        id: '80000000-0000-0000-0005-000000000030',
        tenantId: DEFAULT_TENANT_ID,
        name: 'Local Model (OpenAI-Compatible)',
        slug: 'local-model-openai-compat',
        description: 'Generic local model via OpenAI-compatible API (LM Studio, vLLM, TGI, Groq)',
        category: ModelCategory.NLP,
        taskType: ModelTaskType.TEXT_GENERATION,
        modelType: ModelType.BASE_MODEL,
        source: AiModelSource.LOCAL,
        sourceUri: 'local/openai-compat',
        sourceRevision: 'main',
        format: AiModelFormat.SAFETENSOR,
        memorySizeMb: 0,
        computeType: 'auto',
        tags: ['smr', 'openai-compat', 'default', 'local', 'self-hosted'],
    },

    // --- LM Studio Provider Models (13 models, via OpenAI-compat API) ---
    {
        id: '80000000-0000-0000-0005-000000000040',
        tenantId: DEFAULT_TENANT_ID,
        name: 'Qwen 3.5 4B (LM Studio)',
        slug: 'lms-qwen3.5-4b',
        description: 'Qwen 3.5 4B via LM Studio — compact reasoning model',
        category: ModelCategory.NLP,
        taskType: ModelTaskType.TEXT_GENERATION,
        modelType: ModelType.BASE_MODEL,
        source: AiModelSource.LOCAL,
        sourceUri: 'qwen3.5-4b',
        sourceRevision: 'main',
        format: AiModelFormat.SAFETENSOR,
        memorySizeMb: 3174,
        computeType: 'quantized',
        tags: ['smr', 'lm-studio', 'openai-compat', 'lightweight', 'fast'],
    },
    {
        id: '80000000-0000-0000-0005-000000000041',
        tenantId: DEFAULT_TENANT_ID,
        name: 'Qwen 3.5 0.8B (LM Studio)',
        slug: 'lms-qwen3.5-0.8b',
        description: 'Qwen 3.5 0.8B via LM Studio — smallest model, ideal for testing',
        category: ModelCategory.NLP,
        taskType: ModelTaskType.TEXT_GENERATION,
        modelType: ModelType.BASE_MODEL,
        source: AiModelSource.LOCAL,
        sourceUri: 'qwen3.5-0.8b',
        sourceRevision: 'main',
        format: AiModelFormat.SAFETENSOR,
        memorySizeMb: 973,
        computeType: 'quantized',
        tags: ['smr', 'lm-studio', 'openai-compat', 'lightweight', 'fast', 'default'],
    },
    {
        id: '80000000-0000-0000-0005-000000000042',
        tenantId: DEFAULT_TENANT_ID,
        name: 'Qwen 3.5 9B (LM Studio)',
        slug: 'lms-qwen3.5-9b',
        description: 'Qwen 3.5 9B via LM Studio — balanced reasoning model',
        category: ModelCategory.NLP,
        taskType: ModelTaskType.TEXT_GENERATION,
        modelType: ModelType.BASE_MODEL,
        source: AiModelSource.LOCAL,
        sourceUri: 'qwen/qwen3.5-9b',
        sourceRevision: 'main',
        format: AiModelFormat.SAFETENSOR,
        memorySizeMb: 6246,
        computeType: 'quantized',
        tags: ['smr', 'lm-studio', 'openai-compat', 'balanced'],
    },
    {
        id: '80000000-0000-0000-0005-000000000043',
        tenantId: DEFAULT_TENANT_ID,
        name: 'Qwen 3.5 35B-A3B (LM Studio)',
        slug: 'lms-qwen3.5-35b-a3b',
        description: 'Qwen 3.5 35B-A3B MoE via LM Studio — large sparse model',
        category: ModelCategory.NLP,
        taskType: ModelTaskType.TEXT_GENERATION,
        modelType: ModelType.BASE_MODEL,
        source: AiModelSource.LOCAL,
        sourceUri: 'qwen/qwen3.5-35b-a3b',
        sourceRevision: 'main',
        format: AiModelFormat.SAFETENSOR,
        memorySizeMb: 21094,
        computeType: 'quantized',
        tags: ['smr', 'lm-studio', 'openai-compat', 'high-quality'],
    },
    {
        id: '80000000-0000-0000-0005-000000000044',
        tenantId: DEFAULT_TENANT_ID,
        name: 'LFM2 24B-A2B (LM Studio)',
        slug: 'lms-lfm2-24b-a2b',
        description: 'Liquid LFM2 24B-A2B via LM Studio — efficient MoE model',
        category: ModelCategory.NLP,
        taskType: ModelTaskType.TEXT_GENERATION,
        modelType: ModelType.BASE_MODEL,
        source: AiModelSource.LOCAL,
        sourceUri: 'liquid/lfm2-24b-a2b',
        sourceRevision: 'main',
        format: AiModelFormat.SAFETENSOR,
        memorySizeMb: 12800,
        computeType: 'quantized',
        tags: ['smr', 'lm-studio', 'openai-compat', 'high-quality'],
    },
    {
        id: '80000000-0000-0000-0005-000000000045',
        tenantId: DEFAULT_TENANT_ID,
        name: 'GLM 4.6V Flash (LM Studio)',
        slug: 'lms-glm-4.6v-flash',
        description: 'ZhipuAI GLM 4.6V Flash via LM Studio — fast multimodal model',
        category: ModelCategory.NLP,
        taskType: ModelTaskType.TEXT_GENERATION,
        modelType: ModelType.BASE_MODEL,
        source: AiModelSource.LOCAL,
        sourceUri: 'zai-org/glm-4.6v-flash',
        sourceRevision: 'main',
        format: AiModelFormat.SAFETENSOR,
        memorySizeMb: 6758,
        computeType: 'quantized',
        tags: ['smr', 'lm-studio', 'openai-compat', 'multimodal', 'fast'],
    },
    {
        id: '80000000-0000-0000-0005-000000000046',
        tenantId: DEFAULT_TENANT_ID,
        name: 'LFM2.5 1.2B Instruct MLX (LM Studio)',
        slug: 'lms-lfm2.5-1.2b-instruct',
        description: 'Liquid LFM2.5 1.2B Instruct MLX via LM Studio — tiny instruct model',
        category: ModelCategory.NLP,
        taskType: ModelTaskType.TEXT_GENERATION,
        modelType: ModelType.BASE_MODEL,
        source: AiModelSource.LOCAL,
        sourceUri: 'liquidai/lfm2.5-1.2b-instruct-mlx',
        sourceRevision: 'main',
        format: AiModelFormat.SAFETENSOR,
        memorySizeMb: 2253,
        computeType: 'quantized',
        tags: ['smr', 'lm-studio', 'openai-compat', 'lightweight', 'mlx'],
    },
    {
        id: '80000000-0000-0000-0005-000000000047',
        tenantId: DEFAULT_TENANT_ID,
        name: 'LFM2.5 1.2B Thinking MLX (LM Studio)',
        slug: 'lms-lfm2.5-1.2b-thinking',
        description: 'Liquid LFM2.5 1.2B Thinking MLX via LM Studio — reasoning-focused tiny model',
        category: ModelCategory.NLP,
        taskType: ModelTaskType.TEXT_GENERATION,
        modelType: ModelType.BASE_MODEL,
        source: AiModelSource.LOCAL,
        sourceUri: 'lfm2.5-1.2b-thinking-mlx',
        sourceRevision: 'main',
        format: AiModelFormat.SAFETENSOR,
        memorySizeMb: 2253,
        computeType: 'quantized',
        tags: ['smr', 'lm-studio', 'openai-compat', 'lightweight', 'reasoning', 'mlx'],
    },
    {
        id: '80000000-0000-0000-0005-000000000048',
        tenantId: DEFAULT_TENANT_ID,
        name: 'LFM2.5 VL 1.6B (LM Studio)',
        slug: 'lms-lfm2.5-vl-1.6b',
        description: 'Liquid LFM2.5 VL 1.6B via LM Studio — vision-language model',
        category: ModelCategory.NLP,
        taskType: ModelTaskType.TEXT_GENERATION,
        modelType: ModelType.BASE_MODEL,
        source: AiModelSource.LOCAL,
        sourceUri: 'liquidai/lfm2.5-vl-1.6b',
        sourceRevision: 'main',
        format: AiModelFormat.SAFETENSOR,
        memorySizeMb: 3072,
        computeType: 'quantized',
        tags: ['smr', 'lm-studio', 'openai-compat', 'multimodal', 'lightweight'],
    },
    {
        id: '80000000-0000-0000-0005-000000000049',
        tenantId: DEFAULT_TENANT_ID,
        name: 'TranslateGemma 27B IT (LM Studio)',
        slug: 'lms-translategemma-27b-it',
        description: 'Google TranslateGemma 27B IT via LM Studio — large translation model',
        category: ModelCategory.NLP,
        taskType: ModelTaskType.TEXT_GENERATION,
        modelType: ModelType.BASE_MODEL,
        source: AiModelSource.LOCAL,
        sourceUri: 'translategemma-27b-it',
        sourceRevision: 'main',
        format: AiModelFormat.SAFETENSOR,
        memorySizeMb: 14541,
        computeType: 'quantized',
        tags: ['smr', 'lm-studio', 'openai-compat', 'translation', 'high-quality'],
    },
    {
        id: '80000000-0000-0000-0005-000000000050',
        tenantId: DEFAULT_TENANT_ID,
        name: 'MedGemma 1.5 4B IT MLX (LM Studio)',
        slug: 'lms-medgemma-1.5-4b-mlx',
        description: 'MedGemma 1.5 4B IT MLX Community via LM Studio — medical model (MLX)',
        category: ModelCategory.NLP,
        taskType: ModelTaskType.SUMMARIZATION,
        modelType: ModelType.BASE_MODEL,
        source: AiModelSource.LOCAL,
        sourceUri: 'mlx-community/medgemma-1.5-4b-it',
        sourceRevision: 'main',
        // TASK-356 Phase 1 — corrected to MLX (the slug/tags already say MLX).
        format: AiModelFormat.MLX,
        memorySizeMb: 9523,
        computeType: 'quantized',
        tags: ['smr', 'lm-studio', 'openai-compat', 'medical', 'mlx', 'recommended'],
    },
    {
        id: '80000000-0000-0000-0005-000000000051',
        tenantId: DEFAULT_TENANT_ID,
        name: 'MedGemma 1.5 4B IT Unsloth (LM Studio)',
        slug: 'lms-medgemma-1.5-4b-unsloth',
        description: 'MedGemma 1.5 4B IT Unsloth via LM Studio — medical model (Unsloth)',
        category: ModelCategory.NLP,
        taskType: ModelTaskType.SUMMARIZATION,
        modelType: ModelType.BASE_MODEL,
        source: AiModelSource.LOCAL,
        sourceUri: 'unsloth/medgemma-1.5-4b-it',
        sourceRevision: 'main',
        format: AiModelFormat.SAFETENSOR,
        memorySizeMb: 9011,
        computeType: 'quantized',
        tags: ['smr', 'lm-studio', 'openai-compat', 'medical'],
    },
    {
        id: '80000000-0000-0000-0005-000000000052',
        tenantId: DEFAULT_TENANT_ID,
        name: 'GPT-OSS 20B (LM Studio)',
        slug: 'lms-gpt-oss-20b',
        description: 'GPT-OSS 20B via LM Studio — large open-source GPT-class model',
        category: ModelCategory.NLP,
        taskType: ModelTaskType.TEXT_GENERATION,
        modelType: ModelType.BASE_MODEL,
        source: AiModelSource.LOCAL,
        sourceUri: 'gpt-oss-20b',
        sourceRevision: 'main',
        format: AiModelFormat.SAFETENSOR,
        memorySizeMb: 12595,
        computeType: 'quantized',
        tags: ['smr', 'lm-studio', 'openai-compat', 'high-quality'],
    },

    // =========================================================================
    // Guardrail / Safety Models (TASK-356 Phase 1)
    // =========================================================================
    {
        id: '80000000-0000-0000-0005-000000000060',
        tenantId: DEFAULT_TENANT_ID,
        name: 'Granite Guardian 4.1 8B',
        slug: 'granite-guardian-4.1-8b',
        description: 'IBM Granite Guardian 4.1 8B — safety/guardrail model. `format` is descriptive metadata (GGUF / llama.cpp); serving is provider-based.',
        category: ModelCategory.NLP,
        taskType: ModelTaskType.GUARDRAIL,
        modelType: ModelType.BASE_MODEL,
        source: AiModelSource.LOCAL,
        sourceUri: 'granite-guardian-4.1-8b',
        sourceRevision: 'main',
        format: AiModelFormat.GGUF,
        memorySizeMb: 4900,
        computeType: 'quantized',
        tags: ['guardrail', 'safety', 'granite'],
    },

    // =========================================================================
    // Local Browser STT Models (for @arcaai/stt client-side processing)
    // =========================================================================
    {
        id: '80000000-0000-0000-0006-000000000001',
        tenantId: DEFAULT_TENANT_ID,
        name: 'Whisper Tiny (Local)',
        slug: 'whisper-tiny',
        description: 'ONNX-community Whisper Tiny — ~40MB, fastest local model for browser-based STT',
        category: ModelCategory.AUDIO,
        taskType: ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
        modelType: ModelType.QUANTIZED_MODEL,
        source: AiModelSource.HUGGINGFACE,
        sourceUri: 'onnx-community/whisper-tiny',
        sourceRevision: 'main',
        format: AiModelFormat.ONNX,
        memorySizeMb: 40,
        computeType: 'float32',
        tags: ['multilingual', 'local-processing', 'browser', 'onnx', 'lightweight', 'fast'],
    },
    {
        id: '80000000-0000-0000-0006-000000000002',
        tenantId: DEFAULT_TENANT_ID,
        name: 'Whisper Base (Local)',
        slug: 'whisper-base',
        description: 'ONNX-community Whisper Base — ~75MB, good balance of speed and accuracy for browser STT',
        category: ModelCategory.AUDIO,
        taskType: ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
        modelType: ModelType.QUANTIZED_MODEL,
        source: AiModelSource.HUGGINGFACE,
        sourceUri: 'onnx-community/whisper-base',
        sourceRevision: 'main',
        format: AiModelFormat.ONNX,
        memorySizeMb: 75,
        computeType: 'float32',
        tags: ['multilingual', 'local-processing', 'browser', 'onnx', 'balanced'],
    },
    {
        id: '80000000-0000-0000-0006-000000000003',
        tenantId: DEFAULT_TENANT_ID,
        name: 'Whisper Small (Local)',
        slug: 'whisper-small-local',
        description: 'ONNX-community Whisper Small — ~240MB, higher accuracy for browser-based STT',
        category: ModelCategory.AUDIO,
        taskType: ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
        modelType: ModelType.QUANTIZED_MODEL,
        source: AiModelSource.HUGGINGFACE,
        sourceUri: 'onnx-community/whisper-small',
        sourceRevision: 'main',
        format: AiModelFormat.ONNX,
        memorySizeMb: 240,
        computeType: 'float32',
        tags: ['multilingual', 'local-processing', 'browser', 'onnx', 'balanced', 'recommended'],
    },
    {
        id: '80000000-0000-0000-0006-000000000004',
        tenantId: DEFAULT_TENANT_ID,
        name: 'Whisper Medium (Local)',
        slug: 'whisper-medium-local',
        description: 'ONNX-community Whisper Medium — ~750MB, best accuracy for local browser STT (requires good hardware)',
        category: ModelCategory.AUDIO,
        taskType: ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
        modelType: ModelType.QUANTIZED_MODEL,
        source: AiModelSource.HUGGINGFACE,
        sourceUri: 'onnx-community/whisper-medium',
        sourceRevision: 'main',
        format: AiModelFormat.ONNX,
        memorySizeMb: 750,
        computeType: 'float32',
        tags: ['multilingual', 'local-processing', 'browser', 'onnx', 'high-quality'],
    },
    {
        id: '80000000-0000-0000-0006-000000000005',
        tenantId: DEFAULT_TENANT_ID,
        name: 'Whisper Tiny English (Local)',
        slug: 'whisper-tiny-en',
        description: 'ONNX-community Whisper Tiny English-only — ~40MB, optimized for English-only browser STT',
        category: ModelCategory.AUDIO,
        taskType: ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
        modelType: ModelType.QUANTIZED_MODEL,
        source: AiModelSource.HUGGINGFACE,
        sourceUri: 'onnx-community/whisper-tiny.en',
        sourceRevision: 'main',
        format: AiModelFormat.ONNX,
        memorySizeMb: 40,
        computeType: 'float32',
        tags: ['english-only', 'local-processing', 'browser', 'onnx', 'lightweight', 'fast'],
    },
    {
        id: '80000000-0000-0000-0006-000000000006',
        tenantId: DEFAULT_TENANT_ID,
        name: 'Whisper Base English (Local)',
        slug: 'whisper-base-en',
        description: 'ONNX-community Whisper Base English-only — ~75MB, optimized for English-only browser STT',
        category: ModelCategory.AUDIO,
        taskType: ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
        modelType: ModelType.QUANTIZED_MODEL,
        source: AiModelSource.HUGGINGFACE,
        sourceUri: 'onnx-community/whisper-base.en',
        sourceRevision: 'main',
        format: AiModelFormat.ONNX,
        memorySizeMb: 75,
        computeType: 'float32',
        tags: ['english-only', 'local-processing', 'browser', 'onnx', 'balanced'],
    },
    {
        id: '80000000-0000-0000-0006-000000000007',
        tenantId: DEFAULT_TENANT_ID,
        name: 'Whisper Small English (Local)',
        slug: 'whisper-small-en',
        description: 'ONNX-community Whisper Small English-only — ~240MB, best English accuracy for browser STT',
        category: ModelCategory.AUDIO,
        taskType: ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
        modelType: ModelType.QUANTIZED_MODEL,
        source: AiModelSource.HUGGINGFACE,
        sourceUri: 'onnx-community/whisper-small.en',
        sourceRevision: 'main',
        format: AiModelFormat.ONNX,
        memorySizeMb: 240,
        computeType: 'float32',
        tags: ['english-only', 'local-processing', 'browser', 'onnx', 'balanced', 'recommended'],
    },
];

// =============================================================================
// ASR PIPELINE SEED DATA
// =============================================================================

/**
 * Pipeline YAML configurations
 * Models are referenced by slug (from AiModel table)
 */
const PIPELINE_CONFIGS = {
    // High-quality production pipeline (v1.1 — safetensor, MPS/CUDA/CPU auto)
    production: `version: "1.1"

# Production pipeline: Whisper Large V3 Turbo (safetensor), VAD + denoise
# Uses safetensor engine for automatic MPS/CUDA/CPU acceleration.
# ONNX engine is CPU-only and ~15x slower on Apple Silicon.
models:
  asr:
    hf_model_id: "openai/whisper-large-v3-turbo"
    engine: "safetensor"
  vad:
    hf_model_id: "snakers4/silero-vad"
    engine: "onnx"
    version: "v6.0"
  denoise:
    hf_model_id: "nickolay/rnnoise"
    engine: "onnx"

preprocessing:
  target_sample_rate: 16000
  normalize: true
  vad:
    enabled: true
    threshold: 0.5
    min_speech_duration_ms: 250
    min_silence_duration_ms: 1000
  denoise:
    enabled: true
    strength: 0.7
  # Dual capture (TASK-329 X8 / TASK-331 doc-06 F2): persist the pre-filter
  # (raw) stream alongside the processed stream so the consultation playground
  # can surface RAW+PROCESSED. Toggle per pipeline; enabled on the default.
  dual_capture:
    enabled: true
    capture_raw: true       # capture audio BEFORE noise removal / VAD trimming

inference:
  batch_size: 1
  compute_type: auto
  device: auto
  language: null

postprocessing:
  timestamps:
    word_timestamps: true
    sentence_timestamps: true
  punctuation:
    enabled: true
  remove_disfluencies: false
  lowercase: false
  dual_capture:
    enabled: true
    capture_processed: true # capture audio AFTER all filters
`,

    // Fast turbo pipeline for real-time (v1.1 — safetensor, MPS/CUDA/CPU auto)
    turbo: `version: "1.1"

# Turbo pipeline: Whisper Large V3 Turbo (safetensor), VAD enabled
# Uses safetensor engine for automatic MPS/CUDA/CPU acceleration.
# On Apple Silicon MPS: ~14s for 107s audio. ONNX CPU: ~200s.
models:
  asr:
    hf_model_id: "openai/whisper-large-v3-turbo"
    engine: "safetensor"
  vad:
    hf_model_id: "snakers4/silero-vad"
    engine: "onnx"
    version: "v6.0"

preprocessing:
  target_sample_rate: 16000
  normalize: true
  vad:
    enabled: true
    threshold: 0.5
    min_speech_duration_ms: 200
    min_silence_duration_ms: 500
  denoise:
    enabled: false

inference:
  batch_size: 1
  compute_type: auto
  device: auto
  language: null

postprocessing:
  timestamps:
    word_timestamps: true
    sentence_timestamps: true
  punctuation:
    enabled: true
  remove_disfluencies: false
  lowercase: false
`,

    // Lightweight CPU pipeline (v1.1 — slug-based model ref)
    lightweight: `version: "1.1"

# Lightweight pipeline: Whisper Small, CPU-only, no denoise
models:
  asr: "whisper-small"
  vad:
    hf_model_id: "snakers4/silero-vad"
    engine: "onnx"
    version: "v6.0"

preprocessing:
  target_sample_rate: 16000
  normalize: true
  vad:
    enabled: true
    threshold: 0.6
    min_speech_duration_ms: 300
    min_silence_duration_ms: 1500
  denoise:
    enabled: false

inference:
  batch_size: 4
  compute_type: float32
  device: cpu
  language: null

postprocessing:
  timestamps:
    word_timestamps: false
    sentence_timestamps: true
  punctuation:
    enabled: true
  remove_disfluencies: false
  lowercase: false
`,

    // Optimized pipeline (v1.1 — safetensor, MPS/CUDA/CPU auto)
    optimized: `version: "1.1"

# Optimized pipeline: Whisper Large V3 Turbo (safetensor), VAD + denoise
# Uses safetensor engine for automatic hardware acceleration.
models:
  asr:
    hf_model_id: "openai/whisper-large-v3-turbo"
    engine: "safetensor"
  vad:
    hf_model_id: "snakers4/silero-vad"
    engine: "onnx"
    version: "v6.0"
  denoise:
    hf_model_id: "nickolay/rnnoise"
    engine: "onnx"

preprocessing:
  target_sample_rate: 16000
  normalize: true
  vad:
    enabled: true
    threshold: 0.5
    min_speech_duration_ms: 250
    min_silence_duration_ms: 800
  denoise:
    enabled: true
    strength: 0.7

inference:
  batch_size: 1
  compute_type: auto
  device: auto
  language: null

postprocessing:
  timestamps:
    word_timestamps: true
    sentence_timestamps: true
  punctuation:
    enabled: true
  remove_disfluencies: false
  lowercase: false
`,

    // NeMo pipeline for English (v1.1 — slug-based model ref)
    nemo_english: `version: "1.1"

# NeMo English pipeline: Parakeet CTC 1.1B
models:
  asr: "parakeet-ctc-1.1b"
  vad:
    hf_model_id: "snakers4/silero-vad"
    engine: "onnx"
    version: "v6.0"

preprocessing:
  target_sample_rate: 16000
  normalize: true
  vad:
    enabled: true
    threshold: 0.5
    min_speech_duration_ms: 250
    min_silence_duration_ms: 1000
  denoise:
    enabled: false

inference:
  batch_size: 8
  compute_type: float32
  device: auto
  language: null

postprocessing:
  timestamps:
    word_timestamps: false
    sentence_timestamps: true
  punctuation:
    enabled: true
  remove_disfluencies: false
  lowercase: false
`,

    // Best Practice: High-Quality Real-time Pipeline
    // Uses Silero VAD v6 + RNNoise + Whisper Large V3 Turbo (safetensor)
    best_practice_realtime: `version: "1.1"

# Best practice pipeline for high-quality real-time transcription
# Combines the latest VAD, noise suppression, and ASR models
# Uses safetensor engine for automatic MPS/CUDA/CPU acceleration.
models:
  # ASR: Whisper Large V3 Turbo (safetensor) for fast, hardware-accelerated transcription
  asr:
    hf_model_id: "openai/whisper-large-v3-turbo"
    engine: "safetensor"
  # VAD: Silero VAD v6 for best accuracy with minimal latency
  vad:
    hf_model_id: "snakers4/silero-vad"
    engine: "onnx"
    version: "v6.0"
  # Noise Suppression: RNNoise for lightweight real-time noise removal
  denoise:
    hf_model_id: "nickolay/rnnoise"
    engine: "onnx"

preprocessing:
  vad:
    enabled: true
    threshold: 0.45           # Slightly lower for better speech detection
    min_speech_duration_ms: 200  # Faster response for real-time
    min_silence_duration_ms: 150
    padding_ms: 50            # Smoother transitions
  denoise:
    enabled: true
    strength: 0.7             # Strong but not aggressive noise removal
  target_sample_rate: 16000
  normalize: true

inference:
  batch_size: 8               # Lower batch for real-time latency
  compute_type: float16       # Balanced speed/quality
  device: auto                # Use GPU if available
  num_workers: 4
  beam_size: 5
  temperature: 0.0            # Deterministic output
  language: null              # Auto-detect language

postprocessing:
  timestamps:
    word_timestamps: true     # Enable word-level timestamps
    sentence_timestamps: true
  punctuation:
    enabled: true
  remove_disfluencies: false
  lowercase: false

resources:
  max_memory_mb: 4096
  timeout_seconds: 120
`,

    // Best Practice: High-Quality Batch Processing Pipeline
    // Uses Silero VAD v6 + DeepFilterNet + Whisper Large V3 (safetensor)
    best_practice_batch: `version: "1.1"

# Best practice pipeline for high-quality batch transcription
# Optimized for accuracy over speed
# Uses safetensor engine for automatic MPS/CUDA/CPU acceleration.
models:
  # ASR: Full Whisper Large V3 (safetensor) for maximum accuracy
  asr:
    hf_model_id: "openai/whisper-large-v3"
    engine: "safetensor"
  # VAD: Silero VAD v6 for accurate speech detection
  vad:
    hf_model_id: "snakers4/silero-vad"
    engine: "onnx"
    version: "v6.0"
  # Noise Suppression: DeepFilterNet for high-quality enhancement
  denoise: "deepfilternet-v3"  # Use pre-registered model

preprocessing:
  vad:
    enabled: true
    threshold: 0.5
    min_speech_duration_ms: 250
    min_silence_duration_ms: 200
    padding_ms: 30
  denoise:
    enabled: true
    strength: 0.8             # Aggressive noise removal for clean audio
  target_sample_rate: 16000
  normalize: true

inference:
  batch_size: 16              # Higher batch for throughput
  compute_type: float16
  device: auto
  num_workers: 4
  beam_size: 5
  temperature: 0.0
  language: null

postprocessing:
  timestamps:
    word_timestamps: true
    sentence_timestamps: true
  punctuation:
    enabled: true
  remove_disfluencies: false
  lowercase: false

resources:
  max_memory_mb: 8192
  timeout_seconds: 300
`,

    // =========================================================================
    // CODE-SWITCHING & LANGUAGE-SPECIFIC PIPELINES
    // =========================================================================

    code_switching_en_vi_template: `version: "1.1"

# Code-switching EN-VI pipeline:
# Auto-detects and switches between English and Vietnamese
models:
  asr:
    hf_model_id: "openai/whisper-tiny"
    engine: "safetensor"
  vad:
    hf_model_id: "onnx-community/silero-vad"
    engine: "onnx"

preprocessing:
  target_sample_rate: 16000
  normalize: true
  vad:
    enabled: true
    threshold: 0.5
    min_speech_duration_ms: 250
    min_silence_duration_ms: 500
  denoise:
    enabled: true
    strength: 0.7

inference:
  batch_size: 1
  compute_type: auto
  device: auto
  language: null
  code_switching: true
  initial_prompt: "${TEMPLATE_IDS.WHISPER_INITIAL_PROMPT_EN_VI}"

postprocessing:
  timestamps:
    word_timestamps: true
    sentence_timestamps: true
  punctuation:
    enabled: true
  remove_disfluencies: true
  lowercase: false

diarization:
  enabled: false
`,

    asr_en_template: `version: "1.1"
models:
  asr:
    hf_model_id: openai/whisper-tiny
    engine: safetensor
  vad:
    hf_model_id: onnx-community/silero-vad
    engine: onnx
preprocessing:
  target_sample_rate: 16000
  normalize: true
  vad:
    enabled: true
    threshold: 0.6
    min_speech_duration_ms: 250
    min_silence_duration_ms: 500
    padding_ms: 100
  denoise:
    enabled: true
    strength: 0.3
inference:
  batch_size: 1
  compute_type: auto
  device: auto
  language: en
  beam_size: 1
  temperature: 0
postprocessing:
  timestamps:
    word_timestamps: true
    sentence_timestamps: true
  punctuation:
    enabled: true
  remove_disfluencies: true
  lowercase: false
diarization:
  enabled: false

`,

    asr_ml_template: `version: "1.1"

# ASR Malayalam pipeline:
# Malayalam-only transcription with VAD and denoise
models:
  asr:
    hf_model_id: "openai/whisper-tiny"
    engine: "safetensor"
  vad:
    hf_model_id: "onnx-community/silero-vad"
    engine: "onnx"

preprocessing:
  target_sample_rate: 16000
  normalize: true
  vad:
    enabled: true
    threshold: 0.5
    min_speech_duration_ms: 250
    min_silence_duration_ms: 500
  denoise:
    enabled: true
    strength: 0.3

inference:
  batch_size: 1
  compute_type: auto
  device: auto
  language: "ml"

postprocessing:
  timestamps:
    word_timestamps: true
    sentence_timestamps: true
  punctuation:
    enabled: true
  remove_disfluencies: true
  lowercase: false

diarization:
  enabled: false
`,
};

/**
 * Shape of an ASR pipeline seed row. `isDefault` is optional so most rows can
 * omit it (DB default = false); exactly ONE row per owning tenant should set it
 * `true` (TASK-331 doc-03 Q2 — per-tenant backend default, enforced by tests).
 */
interface AsrPipelineSeed {
    id: string;
    tenantId: string;
    name: string;
    slug: string;
    description: string;
    configYaml: string;
    isDefault?: boolean;
    tags: string[];
}

export const DEFAULT_ASR_PIPELINES: AsrPipelineSeed[] = [
    {
        id: '81000000-0000-0000-0001-000000000001',
        tenantId: DEFAULT_TENANT_ID,
        name: 'Production Pipeline (Whisper Large V3)',
        slug: 'production-whisper-large-v3',
        description: 'High-quality production pipeline using Whisper Large V3 with VAD and noise reduction. Best for final transcriptions.',
        configYaml: PIPELINE_CONFIGS.production,
        // TASK-331 doc-03 Q2 — make the system default agree with the
        // GlobalSetting `default-stt-pipeline` (id 81000000-…0001) so there is
        // a single source of truth. Happy path unchanged: Global-tenant users
        // still resolve this pipeline via the GlobalSetting fallback.
        isDefault: true,
        tags: ['production', 'high-quality', 'recommended'],
    },
    {
        id: '81000000-0000-0000-0001-000000000002',
        tenantId: DEFAULT_TENANT_ID,
        name: 'Turbo Pipeline (Whisper Large V3 Turbo)',
        slug: 'turbo-whisper-large-v3',
        description: 'Fast turbo pipeline using Whisper Large V3 Turbo. Optimized for real-time streaming with minimal latency.',
        configYaml: PIPELINE_CONFIGS.turbo,
        tags: ['streaming', 'real-time', 'fast'],
    },
    {
        id: '81000000-0000-0000-0001-000000000003',
        tenantId: DEFAULT_TENANT_ID,
        name: 'Lightweight Pipeline (Whisper Small)',
        slug: 'lightweight-whisper-small',
        description: 'Lightweight CPU-friendly pipeline using Whisper Small. Suitable for environments without GPU.',
        configYaml: PIPELINE_CONFIGS.lightweight,
        tags: ['cpu', 'lightweight', 'low-resource'],
    },
    {
        id: '81000000-0000-0000-0001-000000000004',
        tenantId: DEFAULT_TENANT_ID,
        name: 'Optimized Pipeline (Faster Whisper ONNX)',
        slug: 'optimized-faster-whisper',
        description: 'Optimized ONNX pipeline using Faster Whisper with CTranslate2. 4x faster than standard Whisper.',
        configYaml: PIPELINE_CONFIGS.optimized,
        tags: ['optimized', 'fast', 'onnx'],
    },
    {
        id: '81000000-0000-0000-0001-000000000005',
        tenantId: DEFAULT_TENANT_ID,
        name: 'NeMo English Pipeline (Parakeet CTC)',
        slug: 'nemo-parakeet-english',
        description: 'NVIDIA NeMo pipeline using Parakeet CTC 1.1B. English-only with high accuracy.',
        configYaml: PIPELINE_CONFIGS.nemo_english,
        tags: ['english', 'nemo', 'nvidia'],
    },
    // =========================================================================
    // BEST PRACTICE PIPELINES (v1.1 with inline model definitions)
    // =========================================================================
    {
        id: '81000000-0000-0000-0001-000000000006',
        tenantId: DEFAULT_TENANT_ID,
        name: 'Best Practice: Real-time (Silero VAD v6 + RNNoise + Whisper Turbo)',
        slug: 'best-practice-realtime',
        description: 'Best practice pipeline for real-time transcription. Uses Silero VAD v6 for accurate speech detection, RNNoise for lightweight noise suppression, and Whisper Large V3 Turbo (safetensor) for fast, hardware-accelerated ASR.',
        configYaml: PIPELINE_CONFIGS.best_practice_realtime,
        tags: ['best-practice', 'real-time', 'streaming', 'recommended', 'v1.1'],
    },
    {
        id: '81000000-0000-0000-0001-000000000007',
        tenantId: DEFAULT_TENANT_ID,
        name: 'Best Practice: Batch (Silero VAD v6 + DeepFilterNet + Whisper Large V3)',
        slug: 'best-practice-batch',
        description: 'Best practice pipeline for high-quality batch transcription. Uses Silero VAD v6, DeepFilterNet for superior noise removal, and Whisper Large V3 (safetensor) for maximum accuracy with hardware acceleration.',
        configYaml: PIPELINE_CONFIGS.best_practice_batch,
        tags: ['best-practice', 'batch', 'high-quality', 'v1.1'],
    },
    // =========================================================================
    // CODE-SWITCHING & LANGUAGE-SPECIFIC PIPELINES
    // =========================================================================
    {
        id: '81000000-0000-0000-0001-000000000050',
        tenantId: DEFAULT_TENANT_ID,
        name: 'Code-Switching EN-VI Template',
        slug: 'code-switching-en-vi-template',
        description: 'Code-switching pipeline template for English-Vietnamese.',
        configYaml: PIPELINE_CONFIGS.code_switching_en_vi_template,
        tags: ['code-switching', 'en', 'vi'],
    },
    {
        id: '81000000-0000-0000-0001-000000000051',
        tenantId: DEFAULT_TENANT_ID,
        name: 'ASR English Template',
        slug: 'asr-en-template',
        description: 'English-only ASR pipeline template.',
        configYaml: PIPELINE_CONFIGS.asr_en_template,
        tags: ['asr', 'english'],
    },
    {
        id: '81000000-0000-0000-0001-000000000052',
        tenantId: DEFAULT_TENANT_ID,
        name: 'ASR Malayalam Template',
        slug: 'asr-ml-template',
        description: 'Malayalam-only ASR pipeline template.',
        configYaml: PIPELINE_CONFIGS.asr_ml_template,
        tags: ['asr', 'malayalam'],
    },
];

// =============================================================================
// PER-CUSTOMER-TENANT ASR PIPELINES (TASK-331 doc-03 F3 / Q2)
//
// The DEFAULT_ASR_PIPELINES above are platform-wide system seeds owned by the
// reserved system tenant. Each customer tenant (ArcaAI/4bits/Mumbai) was
// previously left with ZERO pipelines; this gave admins nothing to manage and
// no per-tenant default. Here we give every customer tenant a small, realistic
// catalog (a production default + a turbo/streaming option) and mark EXACTLY
// ONE as `isDefault: true`. The runtime (resolveRemoteConfig) honours that
// per-tenant default ahead of the GlobalSetting slug default.
//
// ID scheme: kept inside the `81000000-…-0001-…` ASR-pipeline block; the LAST
// UUID group encodes the tenant (1xx=ArcaAI, 2xx=4bits, 3xx=Mumbai) so the IDs
// never collide with the system rows (01-07, 50-52). Slugs are reused per
// tenant — safe under the `@@unique([tenantId, slug])` constraint.
//
// Exported for testing purposes.
// =============================================================================

export const CUSTOMER_TENANT_ASR_PIPELINES: AsrPipelineSeed[] = [
    // --- ArcaAI ---
    {
        id: '81000000-0000-0000-0001-000000000101',
        tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
        name: 'ArcaAI Production Pipeline (Whisper Large V3)',
        slug: 'production-whisper-large-v3',
        description: 'ArcaAI default production pipeline using Whisper Large V3 with VAD and noise reduction.',
        configYaml: PIPELINE_CONFIGS.production,
        isDefault: true,
        tags: ['production', 'high-quality', 'recommended'],
    },
    {
        id: '81000000-0000-0000-0001-000000000102',
        tenantId: SEED_CUSTOMER_TENANT_IDS.ARCAAI,
        name: 'ArcaAI Turbo Pipeline (Whisper Large V3 Turbo)',
        slug: 'turbo-whisper-large-v3',
        description: 'ArcaAI fast streaming pipeline using Whisper Large V3 Turbo for low-latency transcription.',
        configYaml: PIPELINE_CONFIGS.turbo,
        isDefault: false,
        tags: ['streaming', 'real-time', 'fast'],
    },
    // --- 4bits ---
    {
        id: '81000000-0000-0000-0001-000000000201',
        tenantId: SEED_CUSTOMER_TENANT_IDS.FOURBITS,
        name: '4bits Production Pipeline (Whisper Large V3)',
        slug: 'production-whisper-large-v3',
        description: '4bits default production pipeline using Whisper Large V3 with VAD and noise reduction.',
        configYaml: PIPELINE_CONFIGS.production,
        isDefault: true,
        tags: ['production', 'high-quality', 'recommended'],
    },
    {
        id: '81000000-0000-0000-0001-000000000202',
        tenantId: SEED_CUSTOMER_TENANT_IDS.FOURBITS,
        name: '4bits Turbo Pipeline (Whisper Large V3 Turbo)',
        slug: 'turbo-whisper-large-v3',
        description: '4bits fast streaming pipeline using Whisper Large V3 Turbo for low-latency transcription.',
        configYaml: PIPELINE_CONFIGS.turbo,
        isDefault: false,
        tags: ['streaming', 'real-time', 'fast'],
    },
    // --- Mumbai General Hospital ---
    {
        id: '81000000-0000-0000-0001-000000000301',
        tenantId: SEED_CUSTOMER_TENANT_IDS.MUMBAI_HOSPITAL,
        name: 'Mumbai Production Pipeline (Whisper Large V3)',
        slug: 'production-whisper-large-v3',
        description: 'Mumbai General Hospital default production pipeline using Whisper Large V3 with VAD and noise reduction.',
        configYaml: PIPELINE_CONFIGS.production,
        isDefault: true,
        tags: ['production', 'high-quality', 'recommended'],
    },
    {
        id: '81000000-0000-0000-0001-000000000302',
        tenantId: SEED_CUSTOMER_TENANT_IDS.MUMBAI_HOSPITAL,
        name: 'Mumbai Lightweight Pipeline (Whisper Small)',
        slug: 'lightweight-whisper-small',
        description: 'Mumbai General Hospital CPU-friendly fallback pipeline using Whisper Small for low-resource sites.',
        configYaml: PIPELINE_CONFIGS.lightweight,
        isDefault: false,
        tags: ['cpu', 'lightweight', 'low-resource'],
    },
];

// =============================================================================
// GLOBAL CUSTOMER-TENANT ASR PIPELINES (TASK-336 IC-03)
//
// The DEFAULT_ASR_PIPELINES above are owned by the reserved SYSTEM tenant
// (DEFAULT_TENANT_ID === SYSTEM_TENANT_ID) and are NOT shared-read into customer
// tenants, so the Global customer tenant (SEED_TENANT_ID, 50000000-…0000)
// previously had ZERO pipelines: its doctors' public pipeline list resolved to
// [] and the `default-stt-pipeline` GlobalSetting pointed at an unreachable
// SYSTEM row. Here we give the Global tenant its OWN small catalog (a production
// default + a turbo streaming option) and mark EXACTLY ONE `isDefault: true`, so
// the SYSTEM-vs-tenant story matches the customer tenants: SYSTEM owns the master
// catalog; every customer-facing tenant (incl. Global) owns its own pipelines.
//
// ID scheme: stays in the `81000000-…-0001-…` ASR-pipeline block; the trailing
// group uses the 4xx slot (Global) so IDs never collide with the system rows
// (01-07, 50-52) or the other customer tenants (1xx/2xx/3xx). Slugs are reused
// per tenant — safe under `@@unique([tenantId, slug])`.
//
// Kept in a SEPARATE array (not CUSTOMER_TENANT_ASR_PIPELINES) because the seed
// tests require every CUSTOMER_TENANT_ASR_PIPELINES row to be an ArcaAI/4bits/
// Mumbai tenant. Exported for testing + reuse by transcription-job seeds.
// =============================================================================

export const GLOBAL_TENANT_ASR_PIPELINES: AsrPipelineSeed[] = [
    {
        id: '81000000-0000-0000-0001-000000000401',
        tenantId: SEED_TENANT_ID,
        name: 'Global Production Pipeline (Whisper Large V3)',
        slug: 'production-whisper-large-v3',
        description: 'Global tenant default production pipeline using Whisper Large V3 with VAD and noise reduction. Referenced by the tenant `default-stt-pipeline` setting.',
        configYaml: PIPELINE_CONFIGS.production,
        isDefault: true,
        tags: ['production', 'high-quality', 'recommended'],
    },
    {
        id: '81000000-0000-0000-0001-000000000402',
        tenantId: SEED_TENANT_ID,
        name: 'Global Turbo Pipeline (Whisper Large V3 Turbo)',
        slug: 'turbo-whisper-large-v3',
        description: 'Global tenant fast streaming pipeline using Whisper Large V3 Turbo for low-latency transcription.',
        configYaml: PIPELINE_CONFIGS.turbo,
        isDefault: false,
        tags: ['streaming', 'real-time', 'fast'],
    },
];

// =============================================================================
// GLOBAL SETTINGS FOR STT SERVICE
// =============================================================================

export const DEFAULT_STT_SETTINGS = [
    // Model Cache Settings
    {
        id: '82000000-0000-0000-0001-000000000001',
        tenantId: DEFAULT_TENANT_ID,
        namespace: 'stt.config',
        name: 'model_cache',
        key: 'max_models',
        value: '5',
        defaultValue: '5',
        dataType: ValueType.Integer,
        description: 'Maximum number of AI models to keep in memory cache',
    },
    {
        id: '82000000-0000-0000-0001-000000000002',
        tenantId: DEFAULT_TENANT_ID,
        namespace: 'stt.config',
        name: 'model_cache',
        key: 'ttl_seconds',
        value: '3600',
        defaultValue: '3600',
        dataType: ValueType.Integer,
        description: 'Time-to-live for cached models in seconds',
    },
    {
        id: '82000000-0000-0000-0001-000000000003',
        tenantId: DEFAULT_TENANT_ID,
        namespace: 'stt.config',
        name: 'model_cache',
        key: 'max_memory_mb',
        value: '16384',
        defaultValue: '16384',
        dataType: ValueType.Integer,
        description: 'Maximum memory for model cache in MB',
    },

    // Worker Settings
    {
        id: '82000000-0000-0000-0002-000000000001',
        tenantId: DEFAULT_TENANT_ID,
        namespace: 'stt.config',
        name: 'workers',
        key: 'concurrency',
        value: '4',
        defaultValue: '4',
        dataType: ValueType.Integer,
        description: 'Number of concurrent Dramatiq workers',
    },
    {
        id: '82000000-0000-0000-0002-000000000002',
        tenantId: DEFAULT_TENANT_ID,
        namespace: 'stt.config',
        name: 'workers',
        key: 'batch_queue',
        value: 'stt_batch',
        defaultValue: 'stt_batch',
        dataType: ValueType.String,
        description: 'Queue name for batch transcription jobs',
    },
    {
        id: '82000000-0000-0000-0002-000000000003',
        tenantId: DEFAULT_TENANT_ID,
        namespace: 'stt.config',
        name: 'workers',
        key: 'streaming_queue',
        value: 'stt_streaming',
        defaultValue: 'stt_streaming',
        dataType: ValueType.String,
        description: 'Queue name for streaming transcription jobs',
    },

    // Storage Settings
    {
        id: '82000000-0000-0000-0003-000000000001',
        tenantId: DEFAULT_TENANT_ID,
        namespace: 'stt.config',
        name: 'storage',
        key: 'audio_bucket',
        value: 'hope-audio',
        defaultValue: 'hope-audio',
        dataType: ValueType.String,
        description: 'MinIO bucket for audio storage',
    },
    {
        id: '82000000-0000-0000-0003-000000000002',
        tenantId: DEFAULT_TENANT_ID,
        namespace: 'stt.config',
        name: 'storage',
        key: 'chunk_bucket',
        value: 'hope-audio-chunks',
        defaultValue: 'hope-audio-chunks',
        dataType: ValueType.String,
        description: 'MinIO bucket for streaming audio chunks',
    },

    // S3/MinIO Connection Settings (used by S3Service via AppSettingsService)
    {
        id: '82000000-0000-0000-0003-000000000010',
        tenantId: DEFAULT_TENANT_ID,
        namespace: 'platform',
        name: 's3',
        key: 'S3_ENDPOINT',
        value: `http://localhost:${process.env.MINIO_ENDPOINT?.split(':')[1] || '9000'}`,
        defaultValue: 'http://localhost:9000',
        dataType: ValueType.String,
        description: 'S3-compatible storage endpoint (MinIO)',
    },
    {
        id: '82000000-0000-0000-0003-000000000011',
        tenantId: DEFAULT_TENANT_ID,
        namespace: 'platform',
        name: 's3',
        key: 'S3_ACCESS_KEY',
        value: process.env.MINIO_ACCESS_KEY || 'minio_admin',
        defaultValue: 'minio_admin',
        dataType: ValueType.String,
        description: 'S3 access key',
    },
    {
        id: '82000000-0000-0000-0003-000000000012',
        tenantId: DEFAULT_TENANT_ID,
        namespace: 'platform',
        name: 's3',
        key: 'S3_SECRET_KEY',
        value: process.env.MINIO_SECRET_KEY || 'minio_admin',
        defaultValue: 'minio_admin',
        dataType: ValueType.String,
        description: 'S3 secret key',
    },
    {
        id: '82000000-0000-0000-0003-000000000013',
        tenantId: DEFAULT_TENANT_ID,
        namespace: 'platform',
        name: 's3',
        key: 'S3_REGION',
        value: 'us-east-1',
        defaultValue: 'us-east-1',
        dataType: ValueType.String,
        description: 'S3 region',
    },
    {
        id: '82000000-0000-0000-0003-000000000014',
        tenantId: DEFAULT_TENANT_ID,
        namespace: 'platform',
        name: 's3',
        key: 'S3_PRIVATE_BUCKET',
        value: 'hope-private',
        defaultValue: 'hope-private',
        dataType: ValueType.String,
        description: 'Private bucket for voice samples and sensitive files',
    },
    {
        id: '82000000-0000-0000-0003-000000000015',
        tenantId: DEFAULT_TENANT_ID,
        namespace: 'platform',
        name: 's3',
        key: 'S3_PUBLIC_BUCKET',
        value: 'hope-public',
        defaultValue: 'hope-public',
        dataType: ValueType.String,
        description: 'Public bucket for shared assets',
    },
    {
        id: '82000000-0000-0000-0003-000000000016',
        tenantId: DEFAULT_TENANT_ID,
        namespace: 'platform',
        name: 's3',
        key: 'S3_FORCE_PATH_STYLE',
        value: 'true',
        defaultValue: 'true',
        dataType: ValueType.Boolean,
        description: 'Force path-style URLs (required for MinIO)',
    },

    // HuggingFace Settings
    {
        id: '82000000-0000-0000-0004-000000000001',
        tenantId: DEFAULT_TENANT_ID,
        namespace: 'stt.config',
        name: 'huggingface',
        key: 'cache_dir',
        value: '/models/hf-cache',
        defaultValue: '/models/hf-cache',
        dataType: ValueType.String,
        description: 'Local directory for HuggingFace model cache',
    },
    {
        id: '82000000-0000-0000-0004-000000000002',
        tenantId: DEFAULT_TENANT_ID,
        namespace: 'stt.config',
        name: 'huggingface',
        key: 'offline_mode',
        value: 'false',
        defaultValue: 'false',
        dataType: ValueType.Boolean,
        description: 'Run in offline mode (use only cached models)',
    },

    // API Gateway Settings
    {
        id: '82000000-0000-0000-0005-000000000001',
        tenantId: DEFAULT_TENANT_ID,
        namespace: 'stt.config',
        name: 'api_gateway',
        key: 'base_url',
        value: 'http://api:8868/api/v1',
        defaultValue: 'http://api:8868/api/v1',
        dataType: ValueType.String,
        description: 'Internal API Gateway base URL',
    },
    {
        id: '82000000-0000-0000-0005-000000000002',
        tenantId: DEFAULT_TENANT_ID,
        namespace: 'stt.config',
        name: 'api_gateway',
        key: 'timeout_seconds',
        value: '30',
        defaultValue: '30',
        dataType: ValueType.Integer,
        description: 'API Gateway request timeout in seconds',
    },

    // Default Pipeline Settings
    {
        id: '82000000-0000-0000-0006-000000000001',
        tenantId: DEFAULT_TENANT_ID,
        namespace: 'stt.config',
        name: 'defaults',
        key: 'batch_pipeline_slug',
        value: 'production-whisper-large-v3',
        defaultValue: 'production-whisper-large-v3',
        dataType: ValueType.String,
        description: 'Default pipeline slug for batch transcription',
    },
    {
        id: '82000000-0000-0000-0006-000000000002',
        tenantId: DEFAULT_TENANT_ID,
        namespace: 'stt.config',
        name: 'defaults',
        key: 'streaming_pipeline_slug',
        value: 'turbo-whisper-large-v3',
        defaultValue: 'turbo-whisper-large-v3',
        dataType: ValueType.String,
        description: 'Default pipeline slug for streaming transcription',
    },
];

// =============================================================================
// SEED FUNCTIONS
// =============================================================================

export const seedAiModels = async (client: CorePrismaClient) => {
    console.log('Seeding AI Models...');

    for (const modelData of DEFAULT_AI_MODELS) {
        const existing = await client.aiModel.findFirst({
            where: {
                tenantId: modelData.tenantId,
                slug: modelData.slug,
            },
        });

        if (existing) {
            console.log(`  AI Model "${modelData.slug}" already exists, updating...`);
            await client.aiModel.update({
                where: { id: existing.id },
                data: {
                    name: modelData.name,
                    description: modelData.description,
                    category: modelData.category,
                    taskType: modelData.taskType,
                    modelType: modelData.modelType,
                    source: modelData.source,
                    sourceUri: modelData.sourceUri,
                    sourceRevision: modelData.sourceRevision,
                    format: modelData.format,
                    memorySizeMb: modelData.memorySizeMb,
                    computeType: modelData.computeType,
                    tags: modelData.tags,
                },
            });
        } else {
            console.log(`  Creating AI Model "${modelData.slug}"...`);
            await client.aiModel.create({
                data: modelData,
            });
        }
    }

    console.log(`Seeded ${DEFAULT_AI_MODELS.length} AI Models`);
    return { success: true, count: DEFAULT_AI_MODELS.length };
};

/**
 * Customer tenants that receive a clone of the SYSTEM AI model catalog. Mirrors
 * the customer-tenant set used by the per-tenant ASR pipeline / settings seeds.
 */
export const CUSTOMER_TENANT_IDS_FOR_AIMODEL_BACKFILL = [
    SEED_TENANT_ID,
    SEED_CUSTOMER_TENANT_IDS.ARCAAI,
    SEED_CUSTOMER_TENANT_IDS.FOURBITS,
    SEED_CUSTOMER_TENANT_IDS.MUMBAI_HOSPITAL,
];

/**
 * TASK-356 Phase 1 (D-5 backfill) — clones the SYSTEM AI model catalog into
 * every seeded customer tenant so EXISTING tenants are made whole (the runtime
 * `TenantService.provisionTenantModelCatalog` handles NEW tenants).
 *
 * Idempotent: a clone is created only when the tenant does not already own the
 * slug, so re-running `db:seed` fills only the gaps and never duplicates. The
 * SYSTEM rows are never touched (they are the master template); each clone omits
 * the SYSTEM row `id` so Prisma assigns a fresh `uuid(7)`, and download state is
 * intentionally not copied (the column defaults to `NOT_DOWNLOADED`).
 */
export const backfillCustomerTenantAiModels = async (client: CorePrismaClient) => {
    console.log('Backfilling customer-tenant AI model catalog...');

    let cloned = 0;
    for (const tenantId of CUSTOMER_TENANT_IDS_FOR_AIMODEL_BACKFILL) {
        for (const src of DEFAULT_AI_MODELS) {
            const existing = await client.aiModel.findFirst({
                where: { tenantId, slug: src.slug },
            });
            if (existing) {
                continue;
            }

            // Strip the SYSTEM-owned id + tenantId; the clone gets a fresh id
            // (uuid(7) default) and the customer tenant id.
            const { id: _systemId, tenantId: _systemTenantId, ...rest } = src;
            await client.aiModel.create({
                data: { ...rest, tenantId },
            });
            cloned += 1;
        }
    }

    console.log(`Backfilled ${cloned} customer-tenant AI models`);
    return { success: true, count: cloned };
};

export const seedAsrPipelines = async (client: CorePrismaClient) => {
    console.log('Seeding ASR Pipelines...');

    // System (platform-wide) pipelines + Global-tenant pipelines (TASK-336
    // IC-03) + per-customer-tenant pipelines.
    const allPipelines = [
        ...DEFAULT_ASR_PIPELINES,
        ...GLOBAL_TENANT_ASR_PIPELINES,
        ...CUSTOMER_TENANT_ASR_PIPELINES,
    ];

    for (const pipelineData of allPipelines) {
        const existing = await client.asrPipeline.findFirst({
            where: {
                tenantId: pipelineData.tenantId,
                slug: pipelineData.slug,
            },
        });

        if (existing) {
            // Idempotent re-seed: refresh content but DO NOT clobber `isDefault`.
            // The default flag is admin-controlled at runtime (per TASK-331
            // doc-03 Q2); leaving it untouched on update both respects admin
            // changes and keeps the "exactly one default per tenant" invariant
            // intact (no new rows are created, so no second default can appear).
            console.log(`  ASR Pipeline "${pipelineData.slug}" already exists for tenant ${pipelineData.tenantId}, updating...`);
            await client.asrPipeline.update({
                where: { id: existing.id },
                data: {
                    name: pipelineData.name,
                    description: pipelineData.description,
                    configYaml: pipelineData.configYaml,
                    tags: pipelineData.tags,
                },
            });
        } else {
            console.log(`  Creating ASR Pipeline "${pipelineData.slug}" for tenant ${pipelineData.tenantId}...`);
            await client.asrPipeline.create({
                data: pipelineData,
            });
        }
    }

    console.log(`Seeded ${allPipelines.length} ASR Pipelines`);
    return { success: true, count: allPipelines.length };
};

export const seedSttSettings = async (client: CorePrismaClient) => {
    console.log('Seeding STT Global Settings...');

    for (const settingData of DEFAULT_STT_SETTINGS) {
        const existing = await client.globalSetting.findFirst({
            where: {
                tenantId: settingData.tenantId,
                name: settingData.name,
                key: settingData.key,
            },
        });

        if (existing) {
            console.log(`  Setting "${settingData.namespace}.${settingData.name}.${settingData.key}" already exists, updating...`);
            await client.globalSetting.update({
                where: { id: existing.id },
                data: {
                    value: settingData.value,
                    defaultValue: settingData.defaultValue,
                    description: settingData.description,
                },
            });
        } else {
            console.log(`  Creating setting "${settingData.namespace}.${settingData.name}.${settingData.key}"...`);
            await client.globalSetting.create({
                data: settingData,
            });
        }
    }

    console.log(`Seeded ${DEFAULT_STT_SETTINGS.length} STT Settings`);
    return { success: true, count: DEFAULT_STT_SETTINGS.length };
};

/**
 * Main seed function for STT domain
 * Seeds: AI Models → ASR Pipelines → Global Settings
 */
export const seedStt = async (client: CorePrismaClient) => {
    console.log('Starting STT domain seeding...\n');

    try {
        // Seed AI Models first (pipelines reference them by slug)
        await seedAiModels(client);
        console.log('');

        // TASK-356 Phase 1 — clone the SYSTEM catalog into existing customer
        // tenants (idempotent; mirrors the runtime clone-per-tenant).
        await backfillCustomerTenantAiModels(client);
        console.log('');

        // Seed ASR Pipelines
        await seedAsrPipelines(client);
        console.log('');

        // Seed Global Settings
        await seedSttSettings(client);
        console.log('');

        console.log('STT domain seeding completed successfully!');
        return { success: true };
    } catch (error) {
        console.error('Error during STT domain seeding:', error);
        throw error;
    }
};
