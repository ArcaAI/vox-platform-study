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
 * Audio / STT model catalog (consolidated keepers).
 *
 * Exactly the engines the 8-pipeline product matrix references —
 * every row here is either referenced by a seeded pipeline `models:` block or
 * (ECAPA) inline-referenced as the diarization feature extractor. ids/slugs
 * are UNCHANGED from the pre-split `06-stt.ts` (update-in-place on re-seed);
 * backfills `provider`/`architecture`.
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
        // faster-whisper whisper-large-v3-turbo,
        // CTranslate2. Points at the community deepdml
        // conversion (2026-07-16); loads via
        // FasterWhisperLoader at runtime.
        // Precision bumped int8 → f16 per the refreshed product
        // matrix. Slug/id kept for pipeline-YAML continuity even though it
        // still reads "int8" (cosmetic; not renamed to avoid an unrelated
        // slug-rename churn).
        id: '80000000-0000-0000-0001-000000000007',
        tenantId: SYSTEM_TENANT_ID,
        name: 'Faster-Whisper Large V3 Turbo (CT2 f16)',
        slug: 'faster-whisper-large-v3-turbo-int8',
        description: 'whisper-large-v3-turbo converted to CTranslate2 and quantized f16 for faster-whisper (deepdml community conversion). Resolves by slug at runtime.',
        category: ModelCategory.AUDIO,
        taskType: ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
        modelType: ModelType.QUANTIZED_MODEL,
        source: AiModelSource.LOCAL,
        sourceUri: 'deepdml/faster-whisper-large-v3-turbo-ct2',
        sourceRevision: 'main',
        // FASTER_WHISPER (was CTRANSLATE2, which is the
        // legacy transformers-path alias and dispatched to the WRONG loader).
        format: AiModelFormat.FASTER_WHISPER,
        provider: 'built-in',
        architecture: 'whisper',
        memorySizeMb: 3000,
        // CTranslate2's compute_type vocabulary spells this "float16", not the
        // ggml-style "f16" shorthand — resolve_ct2_compute_type() hard-rejects
        // anything outside its validated set (see faster_whisper_asr.py).
        computeType: 'float16',
        // Registered + catalog-visible; production/recommended
        // tags stay off until the CT2 pipeline earns the default via benchmarks.
        tags: ['multilingual', 'faster-whisper', 'ctranslate2', 'float16'],
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
        // The NVIDIA repo carries the raw .nemo checkpoint;
        // parakeet.cpp needs the GGUF conversion (convert script) staged first.
        tags: ['streaming', 'multilingual', 'ggml', 'parakeet.cpp', 'requires-conversion'],
    },
    {
        // whisper-large-v3-turbo served by the whisper.cpp ggml
        // runtime (pywhispercpp binding). Pre-converted GGUF repo — unlike
        // parakeet.cpp, no separate conversion step is required.
        id: '80000000-0000-0000-0001-000000000014',
        tenantId: SYSTEM_TENANT_ID,
        name: 'Whisper Large V3 Turbo (whisper.cpp GGUF)',
        slug: 'whisper-large-v3-turbo-gguf',
        description: 'OpenAI Whisper Large V3 Turbo, GGUF-quantized (q8_0) for the whisper.cpp ggml runtime via the pywhispercpp binding.',
        category: ModelCategory.AUDIO,
        taskType: ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
        modelType: ModelType.QUANTIZED_MODEL,
        source: AiModelSource.HUGGINGFACE,
        sourceUri: 'oxide-lab/whisper-large-v3-turbo-GGUF',
        sourceRevision: 'main',
        format: AiModelFormat.WHISPER_CPP,
        provider: 'built-in',
        architecture: 'whisper',
        memorySizeMb: 900,
        computeType: 'q8_0',
        tags: ['multilingual', 'fast', 'ggml', 'whisper.cpp'],
    },

    // =========================================================================
    // VAD (Voice Activity Detection)
    // =========================================================================
    {
        // reconciled with the STT runtime: the Silero VAD service
        // loads Silero **v5** from `onnx-community/silero-vad`
        // (vad/silero_service.py), so the catalog identity/slug are corrected
        // from the mislabelled "v6"/snakers4 row to the v5 onnx-community model
        // the code actually resolves. Slug is version-neutral (`silero-vad`) to
        // avoid colliding with the retired `silero-vad-v5` ledger entry and to
        // survive future minor-version bumps.
        id: '80000000-0000-0000-0002-000000000004',
        tenantId: SYSTEM_TENANT_ID,
        name: 'Silero VAD v5',
        slug: 'silero-vad',
        description: 'Silero VAD v5 ONNX — the voice-activity detector the stt runtime loads from onnx-community/silero-vad. Lightweight, low-latency; recommended for production.',
        category: ModelCategory.AUDIO,
        taskType: ModelTaskType.VOICE_ACTIVITY_DETECTION,
        modelType: ModelType.BASE_MODEL,
        source: AiModelSource.HUGGINGFACE,
        sourceUri: 'onnx-community/silero-vad',
        sourceRevision: 'main',
        format: AiModelFormat.ONNX,
        provider: 'built-in',
        architecture: 'silero',
        memorySizeMb: 64,
        computeType: 'float32',
        tags: ['vad', 'lightweight', 'v5', 'recommended'],
    },

    // =========================================================================
    // Punctuation restoration
    // =========================================================================
    {
        // the Cadence punctuation/casing model the stt
        // post-processing stage restores with (settings default
        // `punctuation_model_name="Cadence"`). A text task (category NLP) served
        // in-process by the stt punctuation registry; punctuation restoration
        // is modelled here as token classification (per-token punct/case labels).
        id: '80000000-0000-0000-0004-000000000001',
        tenantId: SYSTEM_TENANT_ID,
        name: 'Cadence Punctuation (1B)',
        slug: 'cadence-punctuation',
        description: 'ai4bharat/Cadence — 1B punctuation & casing restoration model used by the stt post-processing stage (cadence-punctuation wrapper). Cadence-Fast (270M) is the direct-load variant for pinned transformers 5.x.',
        category: ModelCategory.NLP,
        taskType: ModelTaskType.TOKEN_CLASSIFICATION,
        modelType: ModelType.BASE_MODEL,
        source: AiModelSource.HUGGINGFACE,
        sourceUri: 'ai4bharat/Cadence',
        sourceRevision: 'main',
        format: AiModelFormat.SAFETENSOR,
        provider: 'built-in',
        architecture: null,
        memorySizeMb: 4096,
        computeType: 'float32',
        tags: ['punctuation', 'stt', 'cadence'],
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
    {
        // Reinstates full-band DNN denoising (superseding the
        // retired `deepfilternet-v3` slug with a fresh row/id, not a
        // resurrection of the deleted one — keeps the retirement
        // ledger historically accurate). Served via the `deepfilternet`
        // Python package (`df.enhance.init_df/enhance`), which auto-downloads
        // its own pretrained checkpoint — sourceUri is the model NAME passed
        // to init_df(), not an HF repo.
        id: '80000000-0000-0000-0003-000000000004',
        tenantId: SYSTEM_TENANT_ID,
        name: 'DeepFilterNet3',
        slug: 'deepfilternet3',
        description: 'DeepFilterNet3 — full-band (48kHz) deep-filtering noise suppression. Stronger suppression than RNNoise at higher compute cost; block-processed (~1s latency) in streaming.',
        category: ModelCategory.AUDIO,
        taskType: ModelTaskType.AUDIO_TO_AUDIO,
        modelType: ModelType.BASE_MODEL,
        source: AiModelSource.LOCAL,
        sourceUri: 'DeepFilterNet3',
        sourceRevision: 'main',
        format: AiModelFormat.PYTORCH,
        provider: 'built-in',
        architecture: 'deepfilternet',
        memorySizeMb: 128,
        computeType: 'float32',
        tags: ['noise-reduction', 'full-band', 'dnn'],
    },

    // =========================================================================
    // Diarization embedding
    // =========================================================================
    {
        // ECAPA-TDNN is the chosen diarization embedding
        // extractor. Catalog row is informational — pipelines reference the
        // embedding model INLINE (models.embedding slug resolution is not
        // implemented). Cutover (vector(192) migration +
        // re-enrollment) is owner-scheduled.
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
    {
        // diarization embedding row matching the STT runtime default
        // (`diarization_hf_model_id` = pyannote/wespeaker-voxceleb-resnet34-LM in
        // core/config/settings.py). Seeded ALONGSIDE the ECAPA row: the seeded
        // pipeline YAMLs still pin `speechbrain/spkrec-ecapa-voxceleb` inline, so
        // ECAPA is kept as an alternative while the catalog now also carries the
        // code default. Reconciles the catalog-vs-code drift additively.
        id: '80000000-0000-0000-0001-000000000015',
        tenantId: SYSTEM_TENANT_ID,
        name: 'WeSpeaker ResNet34 Speaker Embedding (pyannote)',
        slug: 'wespeaker-voxceleb-resnet34',
        description: 'pyannote WeSpeaker ResNet34 VoxCeleb speaker-verification embeddings — the stt diarization feature-extractor default (diarization_hf_model_id). Reconciles the catalog with the running STT default.',
        category: ModelCategory.AUDIO,
        taskType: ModelTaskType.SPEAKER_EMBEDDING,
        modelType: ModelType.BASE_MODEL,
        source: AiModelSource.HUGGINGFACE,
        sourceUri: 'pyannote/wespeaker-voxceleb-resnet34-LM',
        sourceRevision: 'main',
        format: AiModelFormat.PYTORCH,
        provider: 'built-in',
        architecture: 'wespeaker',
        memorySizeMb: 96,
        computeType: 'float32',
        tags: ['diarization', 'speaker-embedding', 'wespeaker', 'default'],
    },
];
