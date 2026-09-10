import { SYSTEM_TENANT_ID } from '../00-constants';
import {
  AiDeploymentKind,
  AiModelAvailability,
  AiModelFormat,
  AiModelSource,
  AiTaskKind,
  ModelCategory,
  ModelTaskType,
  ModelType,
  type AiModelSeed,
} from './shared';

/**
 * Audio catalogue (TASK-860 — the owner's catalogue, exactly): 13 ASR rows,
 * 1 VAD, 2 denoisers, 2 speaker-embedding extractors, plus the Cadence
 * punctuation model (token-classification served IN-PROCESS by `apps/stt`,
 * decision D-4). ids/slugs are UNCHANGED from the previous catalogue for every
 * surviving row (update-in-place on re-seed).
 *
 * Retired here: `whisper-small`, `whisper-large-v3-turbo`,
 * `whisper-large-v3-turbo-gguf` (see `retired.ts`).
 *
 * Cloud rows keep `sourceUri` = the vendor wire id: the STT cloud loaders read
 * `model_config.source_uri` verbatim (`openai_loader.py:67`,
 * `azure_speech_loader.py:200`), and `wireModelId` mirrors it until TASK-862
 * re-points the loaders at the new column.
 */
export const AUDIO_AI_MODELS: AiModelSeed[] = [
  // =========================================================================
  // automatic-speech-recognition — self-hosted (apps/stt, stt-worker)
  // =========================================================================
  {
    // faster-whisper whisper-large-v3-turbo, CTranslate2 (deepdml community
    // conversion). Slug/id kept for pipeline-YAML continuity even though it
    // still reads "int8" — the artifact is served int8_float16.
    id: '80000000-0000-0000-0001-000000000007',
    tenantId: SYSTEM_TENANT_ID,
    name: 'Faster-Whisper Large V3 Turbo (CT2 int8)',
    slug: 'faster-whisper-large-v3-turbo-int8',
    description:
      'whisper-large-v3-turbo converted to CTranslate2 (deepdml community conversion), served int8_float16 by faster-whisper. Resolves by slug at runtime.',
    category: ModelCategory.AUDIO,
    taskType: ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
    modelType: ModelType.QUANTIZED_MODEL,
    source: AiModelSource.HUGGINGFACE,
    sourceUri: 'deepdml/faster-whisper-large-v3-turbo-ct2',
    sourceRevision: 'main',
    format: AiModelFormat.FASTER_WHISPER,
    libraryName: 'faster-whisper',
    servedBy: 'stt',
    deploymentKind: AiDeploymentKind.SELF_HOSTED,
    license: 'mit',
    baseModel: 'openai/whisper-large-v3-turbo',
    languages: ['en', 'ml'],
    provider: 'built-in',
    architecture: 'whisper',
    memorySizeMb: 3000,
    // CTranslate2's compute_type vocabulary — resolve_ct2_compute_type()
    // hard-rejects anything outside its validated set.
    computeType: 'int8_float16',
    tags: ['multilingual', 'faster-whisper', 'ctranslate2', 'int8'],
  },
  {
    // NVIDIA Nemotron 3.5 streaming ASR (cache-aware FastConformer-RNNT).
    // Day-1 runtime is transformers `AutoModelForRNNT` (owner decision D-3 /
    // OD-3); the parakeet.cpp GGUF path stays an optional engine. The NVIDIA
    // repo carries the safetensors checkpoint the transformers loader reads.
    id: '80000000-0000-0000-0001-000000000012',
    tenantId: SYSTEM_TENANT_ID,
    name: 'Nemotron 3.5 ASR Streaming 0.6B',
    slug: 'nemotron-3.5-asr-streaming-0.6b',
    description:
      'NVIDIA nemotron-3.5-asr-streaming-0.6b (cache-aware FastConformer-RNNT, 40 locales, OpenMDW-1.1) served by transformers AutoModelForRNNT. No Malayalam.',
    category: ModelCategory.AUDIO,
    taskType: ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
    modelType: ModelType.BASE_MODEL,
    source: AiModelSource.HUGGINGFACE,
    sourceUri: 'nvidia/nemotron-3.5-asr-streaming-0.6b',
    sourceRevision: 'main',
    format: AiModelFormat.SAFETENSOR,
    libraryName: 'transformers',
    servedBy: 'stt',
    deploymentKind: AiDeploymentKind.SELF_HOSTED,
    license: 'openmdw-1.1',
    languages: ['en'],
    provider: 'built-in',
    architecture: 'fastconformer-rnnt',
    memorySizeMb: 1600,
    computeType: 'float16',
    tags: ['streaming', 'multilingual', 'rnnt', 'transformers'],
  },
  {
    // ArcaAI in-house Malayalam+English code-switch full fine-tune of
    // whisper-large-v3-turbo, GGUF (f16) for whisper.cpp. Private Hub repo —
    // the publisher needs the SYSTEM `model-registry:huggingface` token.
    id: '80000000-0000-0000-0001-000000000018',
    tenantId: SYSTEM_TENANT_ID,
    name: 'ArcaAI Whisper Large ML-EN Code-Switch (whisper.cpp GGUF)',
    slug: 'arcaai-whisper-large-ml-en-gguf',
    description:
      'ArcaAI Malayalam+English code-switch full fine-tune of Whisper Large V3 Turbo, GGUF (f16) for the whisper.cpp ggml runtime via the pywhispercpp binding. Platform default for speech-to-text — the row the seeded realtime-transcription agent actually serves.',
    category: ModelCategory.AUDIO,
    taskType: ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
    modelType: ModelType.QUANTIZED_MODEL,
    source: AiModelSource.HUGGINGFACE,
    sourceUri: 'taphuynh/whisper-turbo-ml-en-codeswitch-fullft-2607.29.1-GGUF',
    sourceRevision: 'main',
    format: AiModelFormat.WHISPER_CPP,
    libraryName: 'whisper.cpp',
    servedBy: 'stt',
    deploymentKind: AiDeploymentKind.SELF_HOSTED,
    baseModel: 'openai/whisper-large-v3-turbo',
    languages: ['ml', 'en'],
    // TASK-938 (owner directive 2026-09-09): the election follows the row the seeded
    // `realtime-transcription` agent SERVES as primary — TASK-934 OD-2's own rule — and this
    // ticket moves the agent back to F16. Quantisation is near-free on accuracy either way
    // (q8_0 0.381 CER @ 7s vs f16 0.386 @ 7s, TASK-934), so this is a revert of the ROW, not
    // a claim that q8_0 measured worse.
    isPlatformDefaultFor: [AiTaskKind.SPEECH_TO_TEXT],
    provider: 'built-in',
    architecture: 'whisper',
    memorySizeMb: 1700,
    computeType: 'f16',
    // TASK-880 established the decode geometry that used to be the platform keys
    // `stt.whisperCpp.maxAudioSeconds` and `stt.streaming.partialWindowS` — model facts,
    // not box facts, so they ride the row and travel on `ResolvedAsrSpec.models.asr.metadata`.
    //
    // TASK-891 (A5) raised both to 30/30, matched, reasoning that whisper's encoder always
    // processes a fixed 30s mel-spectrogram window so a longer window costs nothing extra.
    // TASK-934 measured that reasoning against live Malayalam-English CER and reverted it:
    // 30s DOUBLES this fine-tune's CER relative to 7s (0.381 -> 0.645, both quantisations) —
    // the encoder's context length is not the same thing as this model's ACCURACY window,
    // which stays 7s. `partialWindowSec` and `maxDecodeWindowSec` are no longer required to
    // match ("so the last partial and the final decode the SAME audio" — the old
    // `session_manager.py` comment): TASK-934 lane S decoupled them into two independent
    // knobs. The final decode stays at this fine-tune's measured 7s accuracy window; the
    // partial window widens to 15s because a SHORT partial window is where the damage
    // actually was — 6s partials measured 31% garbage on English streaming output, 15s
    // measured 0%. Live proof on the merged build: discharge-clip WER 0.274 -> 0.081.
    metaData: { asr: { maxDecodeWindowSec: 7, partialWindowSec: 6, decoding: { hotwords: ["ceftriaxone", "amoxicillin", "piperacillin-tazobactam", "vancomycin", "ceftazidime", "azithromycin", "metronidazole", "troponin", "creatinine", "metformin", "lisinopril", "atorvastatin", "bisoprolol", "apixaban", "furosemide", "levothyroxine", "salbutamol", "prednisolone", "amlodipine", "omeprazole"] } } },
    tags: ['multilingual', 'malayalam', 'english', 'code-switch', 'ggml', 'whisper.cpp', 'private-repo'],
  },
  {
    // Same repo as the f16 row; the quant is chosen by `computeType`, which
    // `whisper_cpp_loader._select_gguf_file` matches the GGUF filename on.
    id: '80000000-0000-0000-0001-000000000019',
    tenantId: SYSTEM_TENANT_ID,
    name: 'ArcaAI Whisper Large ML-EN Code-Switch (whisper.cpp GGUF q8_0)',
    slug: 'arcaai-whisper-large-ml-en-gguf-q8_0',
    description:
      'ArcaAI Malayalam+English code-switch full fine-tune of Whisper Large V3 Turbo, GGUF (q8_0) for the whisper.cpp ggml runtime via the pywhispercpp binding. First fallback behind the f16 platform default.',
    category: ModelCategory.AUDIO,
    taskType: ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
    modelType: ModelType.QUANTIZED_MODEL,
    source: AiModelSource.HUGGINGFACE,
    sourceUri: 'taphuynh/whisper-turbo-ml-en-codeswitch-fullft-2607.29.1-GGUF',
    sourceRevision: 'main',
    format: AiModelFormat.WHISPER_CPP,
    libraryName: 'whisper.cpp',
    servedBy: 'stt',
    deploymentKind: AiDeploymentKind.SELF_HOSTED,
    baseModel: 'openai/whisper-large-v3-turbo',
    languages: ['ml', 'en'],
    provider: 'built-in',
    architecture: 'whisper',
    memorySizeMb: 900,
    computeType: 'q8_0',
    // TASK-880 — the decode geometry that used to be the platform keys
    // `stt.whisperCpp.maxAudioSeconds` and `stt.streaming.partialWindowS`. Both applied
    // ONE number to every engine on the box; they describe THIS runtime, so they ride
    // the row and travel on `ResolvedAsrSpec.models.asr.metadata`. TASK-934 measured the
    // two windows independently (lane S decoupled them from the earlier "MUST match"
    // rule): 7s remains this fine-tune's accuracy window for the FINAL decode (Malayalam
    // CER doubles at 30s: 0.381 -> 0.645); the PARTIAL window widens to 15s because that is
    // where the streaming damage actually was — a 6s partial window measured 31% garbage
    // on English, 15s measured 0%, and the last partial no longer needs to decode the same
    // span as the final now that the two are independent. Live proof on the merged build:
    // discharge-clip WER 0.274 -> 0.081.
    metaData: { asr: { maxDecodeWindowSec: 7, partialWindowSec: 6, decoding: { hotwords: ["ceftriaxone", "amoxicillin", "piperacillin-tazobactam", "vancomycin", "ceftazidime", "azithromycin", "metronidazole", "troponin", "creatinine", "metformin", "lisinopril", "atorvastatin", "bisoprolol", "apixaban", "furosemide", "levothyroxine", "salbutamol", "prednisolone", "amlodipine", "omeprazole"] } } },
    tags: ['multilingual', 'malayalam', 'english', 'code-switch', 'ggml', 'whisper.cpp', 'private-repo'],
  },
  {
    // Same fine-tune, fp16 safetensor checkpoint served via transformers.
    id: '80000000-0000-0000-0001-000000000020',
    tenantId: SYSTEM_TENANT_ID,
    name: 'ArcaAI Whisper Large ML-EN Code-Switch (transformers)',
    slug: 'arcaai-whisper-large-ml-en',
    description: 'ArcaAI Malayalam+English code-switch full fine-tune of Whisper Large V3 Turbo (fp16 safetensor) served via the transformers runtime.',
    category: ModelCategory.AUDIO,
    taskType: ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
    modelType: ModelType.FINETUNED_MODEL,
    source: AiModelSource.HUGGINGFACE,
    sourceUri: 'taphuynh/whisper-turbo-ml-en-codeswitch-fullft-2607.29.1-fp16',
    sourceRevision: 'main',
    format: AiModelFormat.SAFETENSOR,
    libraryName: 'transformers',
    servedBy: 'stt',
    deploymentKind: AiDeploymentKind.SELF_HOSTED,
    baseModel: 'openai/whisper-large-v3-turbo',
    languages: ['ml', 'en'],
    provider: 'built-in',
    architecture: 'whisper',
    memorySizeMb: 3584,
    computeType: 'float16',
    tags: ['multilingual', 'malayalam', 'english', 'code-switch', 'transformers', 'private-repo'],
  },
  {
    // CTranslate2 conversion of the same fine-tune for faster-whisper.
    id: '80000000-0000-0000-0001-000000000021',
    tenantId: SYSTEM_TENANT_ID,
    name: 'ArcaAI Whisper Large ML-EN Code-Switch (CTranslate2)',
    slug: 'arcaai-whisper-large-ml-en-ct2',
    description: 'ArcaAI Malayalam+English code-switch full fine-tune of Whisper Large V3 Turbo, converted to CTranslate2 for the faster-whisper runtime.',
    category: ModelCategory.AUDIO,
    taskType: ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
    modelType: ModelType.QUANTIZED_MODEL,
    source: AiModelSource.HUGGINGFACE,
    sourceUri: 'taphuynh/whisper-turbo-ml-en-codeswitch-fullft-2607.29.1-ct2',
    sourceRevision: 'main',
    format: AiModelFormat.FASTER_WHISPER,
    libraryName: 'faster-whisper',
    servedBy: 'stt',
    deploymentKind: AiDeploymentKind.SELF_HOSTED,
    baseModel: 'openai/whisper-large-v3-turbo',
    languages: ['ml', 'en'],
    provider: 'built-in',
    architecture: 'whisper',
    memorySizeMb: 3000,
    computeType: 'float16',
    tags: ['multilingual', 'malayalam', 'english', 'code-switch', 'faster-whisper', 'ctranslate2', 'private-repo'],
  },
  {
    // ArcaAI in-house English medical fine-tune (2607.26 merge), GGUF f16 for
    // whisper.cpp. Verified against the HF API 2026-09-02: the repo carries
    // the dotted date segment.
    id: '80000000-0000-0000-0001-000000000022',
    tenantId: SYSTEM_TENANT_ID,
    name: 'ArcaAI Whisper Large EN-Medical (2607.26 merge, whisper.cpp GGUF)',
    slug: 'whisper-large-en-medical-260726-merged-gguf',
    description: 'ArcaAI in-house English medical fine-tune (2607.26 merge), GGUF (f16) for the whisper.cpp ggml runtime.',
    category: ModelCategory.AUDIO,
    taskType: ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
    modelType: ModelType.QUANTIZED_MODEL,
    source: AiModelSource.HUGGINGFACE,
    sourceUri: 'taphuynh/whisper-large-en-medical-2607.26-merged-gguf',
    sourceRevision: 'main',
    format: AiModelFormat.WHISPER_CPP,
    libraryName: 'whisper.cpp',
    servedBy: 'stt',
    deploymentKind: AiDeploymentKind.SELF_HOSTED,
    baseModel: 'openai/whisper-large-v3',
    languages: ['en'],
    provider: 'built-in',
    architecture: 'whisper',
    memorySizeMb: 1700,
    computeType: 'f16',
    // TASK-880 — the decode geometry that used to be the platform keys
    // `stt.whisperCpp.maxAudioSeconds` and `stt.streaming.partialWindowS`. Both applied
    // ONE number to every engine on the box; they describe THIS runtime, so they ride
    // the row and travel on `ResolvedAsrSpec.models.asr.metadata`. 7s stays this fine-tune
    // family's accuracy window for the FINAL decode. TASK-934 (OD-1) applies the measured
    // ml-en profile to every whisper.cpp fine-tune row uniformly and drops the earlier
    // "MUST match" rule: `partialWindowSec` and `maxDecodeWindowSec` are independent knobs
    // (lane S) — the partial window widens to 15s because a short partial window is where
    // the streaming damage measured on the sibling ml-en fine-tune actually was (31%
    // garbage at 6s, 0% at 15s), while the final decode keeps its own 7s accuracy window.
    metaData: { asr: { maxDecodeWindowSec: 7, partialWindowSec: 6, decoding: { hotwords: ["ceftriaxone", "amoxicillin", "piperacillin-tazobactam", "vancomycin", "ceftazidime", "azithromycin", "metronidazole", "troponin", "creatinine", "metformin", "lisinopril", "atorvastatin", "bisoprolol", "apixaban", "furosemide", "levothyroxine", "salbutamol", "prednisolone", "amlodipine", "omeprazole"] } } },
    tags: ['english', 'medical', 'fine-tune', 'ggml', 'whisper.cpp', 'private-repo'],
  },
  {
    // The q8_0 build of the SAME repo — the engine the realtime transcription
    // agent binds. A separate row rather than a `computeType` edit: one row
    // cannot stand for two quantizations of one repo.
    id: '80000000-0000-0000-0001-000000000024',
    tenantId: SYSTEM_TENANT_ID,
    name: 'ArcaAI Whisper Large EN-Medical (2607.26 merge, whisper.cpp GGUF q8_0)',
    slug: 'whisper-large-en-medical-260726-merged-gguf-q8_0',
    description:
      'ArcaAI in-house English medical fine-tune (2607.26 merge), GGUF (q8_0) for the whisper.cpp ggml runtime via the pywhispercpp binding. The engine the realtime transcription agent binds.',
    category: ModelCategory.AUDIO,
    taskType: ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
    modelType: ModelType.QUANTIZED_MODEL,
    source: AiModelSource.HUGGINGFACE,
    sourceUri: 'taphuynh/whisper-large-en-medical-2607.26-merged-gguf',
    sourceRevision: 'main',
    format: AiModelFormat.WHISPER_CPP,
    libraryName: 'whisper.cpp',
    servedBy: 'stt',
    deploymentKind: AiDeploymentKind.SELF_HOSTED,
    baseModel: 'openai/whisper-large-v3',
    languages: ['en'],
    provider: 'built-in',
    architecture: 'whisper',
    memorySizeMb: 1700,
    computeType: 'q8_0',
    // TASK-880 — the decode geometry that used to be the platform keys
    // `stt.whisperCpp.maxAudioSeconds` and `stt.streaming.partialWindowS`. Both applied
    // ONE number to every engine on the box; they describe THIS runtime, so they ride
    // the row and travel on `ResolvedAsrSpec.models.asr.metadata`. 7s stays this fine-tune
    // family's accuracy window for the FINAL decode. TASK-934 (OD-1) applies the measured
    // ml-en profile to every whisper.cpp fine-tune row uniformly and drops the earlier
    // "MUST match" rule: `partialWindowSec` and `maxDecodeWindowSec` are independent knobs
    // (lane S) — the partial window widens to 15s because a short partial window is where
    // the streaming damage measured on the sibling ml-en fine-tune actually was (31%
    // garbage at 6s, 0% at 15s), while the final decode keeps its own 7s accuracy window.
    metaData: { asr: { maxDecodeWindowSec: 7, partialWindowSec: 6, decoding: { hotwords: ["ceftriaxone", "amoxicillin", "piperacillin-tazobactam", "vancomycin", "ceftazidime", "azithromycin", "metronidazole", "troponin", "creatinine", "metformin", "lisinopril", "atorvastatin", "bisoprolol", "apixaban", "furosemide", "levothyroxine", "salbutamol", "prednisolone", "amlodipine", "omeprazole"] } } },
    tags: ['english', 'medical', 'fine-tune', 'ggml', 'whisper.cpp', 'q8_0', 'private-repo'],
  },
  {
    // CTranslate2 build of the same medical fine-tune for faster-whisper.
    id: '80000000-0000-0000-0001-000000000023',
    tenantId: SYSTEM_TENANT_ID,
    name: 'ArcaAI Whisper Large EN-Medical (2607.26 merge, CTranslate2)',
    slug: 'whisper-large-en-medical-260726-merged-ct2',
    description: 'ArcaAI in-house English medical fine-tune (2607.26 merge), converted to CTranslate2 for the faster-whisper runtime.',
    category: ModelCategory.AUDIO,
    taskType: ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
    modelType: ModelType.QUANTIZED_MODEL,
    source: AiModelSource.HUGGINGFACE,
    sourceUri: 'taphuynh/whisper-large-en-medical-2607.26-merged-ct2',
    sourceRevision: 'main',
    format: AiModelFormat.FASTER_WHISPER,
    libraryName: 'faster-whisper',
    servedBy: 'stt',
    deploymentKind: AiDeploymentKind.SELF_HOSTED,
    baseModel: 'openai/whisper-large-v3',
    languages: ['en'],
    provider: 'built-in',
    architecture: 'whisper',
    memorySizeMb: 3000,
    computeType: 'float16',
    tags: ['english', 'medical', 'fine-tune', 'faster-whisper', 'ctranslate2', 'private-repo'],
  },

  // =========================================================================
  // automatic-speech-recognition — cloud (gateway-governed, executed by stt)
  // =========================================================================
  {
    id: '80000000-0000-0000-0001-000000000010',
    tenantId: SYSTEM_TENANT_ID,
    name: 'Azure Speech STT',
    slug: 'azure-speech-stt',
    description: 'Azure Cognitive Services Speech-to-Text (cloud). Credentials via the tenant → SYSTEM `stt`/`azure` provider connection. `ml-IN` supported.',
    category: ModelCategory.AUDIO,
    taskType: ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
    modelType: ModelType.BASE_MODEL,
    source: AiModelSource.LOCAL,
    sourceUri: 'azure://speech-to-text',
    sourceRevision: 'main',
    format: AiModelFormat.AZURE_SPEECH,
    libraryName: 'azure-speech',
    servedBy: 'stt',
    deploymentKind: AiDeploymentKind.CLOUD,
    wireModelId: 'azure://speech-to-text',
    languages: ['en', 'ml'],
    availability: AiModelAvailability.NOT_APPLICABLE,
    // TASK-888 — `azure-speech`, not `azure`: the `stt` plane's BYO vocabulary
    // (`CLOUD_BYO_PROVIDERS.stt`), the SYSTEM `AiProviderConnection` row and
    // `azure_speech_loader.override_key` all spell it this way, and
    // `AsrAgentResolverService.resolveCredentials` gates a streaming session's
    // credential on THIS value.
    provider: 'azure-speech',
    architecture: null,
    memorySizeMb: 0,
    computeType: 'cloud',
    tags: ['cloud', 'azure', 'multilingual'],
  },
  {
    // PREVIEW service, batch-only. TASK-880 — the engine's gate is its own
    // `AiProviderConnection(stt, azure-foundry)` row (SYSTEM-seeded disabled), not the
    // deleted `AZURE_FOUNDRY_ENABLED` / `stt.azureFoundry.enabled` platform flag.
    // `MAI-Transcribe-1` was deprecated by Microsoft on 2026-08-20.
    id: '80000000-0000-0000-0001-000000000011',
    tenantId: SYSTEM_TENANT_ID,
    name: 'Azure MAI-Transcribe 1.5',
    slug: 'mai-transcribe-1.5',
    description:
      'Microsoft MAI-Transcribe 1.5 via the Azure AI Foundry LLM Speech API (PREVIEW — no SLA, no diarization; batch-only). The Foundry lineup is MAI-Transcribe-1.5 and -2.',
    category: ModelCategory.AUDIO,
    taskType: ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
    modelType: ModelType.BASE_MODEL,
    source: AiModelSource.LOCAL,
    sourceUri: 'mai-transcribe-1.5',
    sourceRevision: 'main',
    format: AiModelFormat.AZURE_FOUNDRY,
    libraryName: 'azure-foundry',
    servedBy: 'stt',
    deploymentKind: AiDeploymentKind.CLOUD,
    wireModelId: 'mai-transcribe-1.5',
    languages: ['en'],
    availability: AiModelAvailability.NOT_APPLICABLE,
    // TASK-888 — its own vendor id, separate from `azure-speech` for the same
    // reason its connection row is (data residency on a PREVIEW service).
    provider: 'azure-foundry',
    architecture: null,
    memorySizeMb: 0,
    computeType: 'cloud',
    tags: ['cloud', 'azure-foundry', 'preview', 'multilingual', 'batch'],
  },
  {
    id: '80000000-0000-0000-0001-000000000016',
    tenantId: SYSTEM_TENANT_ID,
    name: 'Sarvam Saaras v4 (STT)',
    slug: 'sarvam-saaras-v4',
    description:
      'Sarvam AI speech-to-text (saaras:v4, code-switch capable, 10+ Indic languages + English; WebSocket streaming). Cloud; per-tenant BYOK via the `stt`/`sarvam` provider connection.',
    category: ModelCategory.AUDIO,
    taskType: ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
    modelType: ModelType.BASE_MODEL,
    source: AiModelSource.LOCAL,
    sourceUri: 'saaras:v4',
    sourceRevision: 'main',
    format: AiModelFormat.SARVAM,
    libraryName: 'sarvam',
    servedBy: 'stt',
    deploymentKind: AiDeploymentKind.CLOUD,
    wireModelId: 'saaras:v4',
    languages: ['ml', 'en', 'hi', 'ta', 'te', 'kn'],
    availability: AiModelAvailability.NOT_APPLICABLE,
    provider: 'sarvam',
    architecture: null,
    memorySizeMb: 0,
    computeType: 'cloud',
    tags: ['cloud', 'sarvam', 'byok', 'multilingual', 'streaming'],
  },
  {
    // OD-2 (open): OpenAI lists `gpt-transcribe` (default) and
    // `gpt-4o-transcribe-diarize` as the successors of `gpt-4o-transcribe`,
    // which is on its retirement page. The wire id stays until the owner
    // confirms the replacement.
    id: '80000000-0000-0000-0001-000000000017',
    tenantId: SYSTEM_TENANT_ID,
    name: 'OpenAI GPT-4o Transcribe (STT)',
    slug: 'openai-gpt4o-transcribe',
    description:
      'OpenAI speech-to-text (gpt-4o-transcribe; POST /v1/audio/transcriptions). Cloud; per-tenant BYOK via the `stt`/`openai` provider connection. Wire id to be confirmed (OD-2).',
    category: ModelCategory.AUDIO,
    taskType: ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
    modelType: ModelType.BASE_MODEL,
    source: AiModelSource.LOCAL,
    sourceUri: 'gpt-4o-transcribe',
    sourceRevision: 'main',
    format: AiModelFormat.OPENAI,
    libraryName: 'openai',
    servedBy: 'stt',
    deploymentKind: AiDeploymentKind.CLOUD,
    wireModelId: 'gpt-4o-transcribe',
    languages: ['en', 'ml'],
    availability: AiModelAvailability.NOT_APPLICABLE,
    provider: 'openai',
    architecture: null,
    memorySizeMb: 0,
    computeType: 'cloud',
    tags: ['cloud', 'openai', 'byok', 'multilingual'],
  },

  // =========================================================================
  // voice-activity-detection
  // =========================================================================
  {
    // Silero VAD v5 ONNX from the `onnx-community` mirror — the identity the
    // stt runtime actually resolves (vad/silero_service.py). Canonical upstream
    // is `snakers4/silero-vad` (PyPI `silero-vad` / GitHub); recorded as the
    // base model.
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
    libraryName: 'onnxruntime',
    servedBy: 'stt',
    deploymentKind: AiDeploymentKind.SELF_HOSTED,
    license: 'mit',
    baseModel: 'snakers4/silero-vad',
    languages: [],
    provider: 'built-in',
    architecture: 'silero',
    memorySizeMb: 64,
    computeType: 'float32',
    tags: ['vad', 'lightweight', 'v5', 'recommended'],
  },

  // =========================================================================
  // audio-to-audio — denoisers
  // =========================================================================
  {
    // No Hub repo exists for RNNoise (`nickolay/rnnoise` was invalid); the
    // coefficients are compiled into the `pyrnnoise` package — nothing to
    // publish, so availability is NOT_APPLICABLE by construction.
    id: '80000000-0000-0000-0003-000000000003',
    tenantId: SYSTEM_TENANT_ID,
    name: 'RNNoise',
    slug: 'rnnoise',
    description: 'RNNoise — lightweight recurrent-network noise suppression (pyrnnoise). Frame-accurate default denoiser for real-time capture; weights ship inside the package.',
    category: ModelCategory.AUDIO,
    taskType: ModelTaskType.AUDIO_TO_AUDIO,
    modelType: ModelType.BASE_MODEL,
    source: AiModelSource.LOCAL,
    sourceUri: 'pypi:pyrnnoise',
    sourceRevision: 'main',
    format: AiModelFormat.PYTORCH,
    libraryName: 'pyrnnoise',
    servedBy: 'stt',
    deploymentKind: AiDeploymentKind.SELF_HOSTED,
    license: 'bsd-3-clause',
    languages: [],
    availability: AiModelAvailability.NOT_APPLICABLE,
    provider: 'built-in',
    architecture: 'rnnoise',
    memorySizeMb: 32,
    computeType: 'float32',
    tags: ['noise-reduction', 'real-time', 'lightweight', 'cpu-friendly'],
  },
  {
    // DeepFilterNet3 — the checkpoint is package-resolved (`df.enhance.init_df`
    // ships the DeepFilterNet3 model inside the `deepfilternet` wheel), so
    // there is nothing in the bucket either. Selecting this engine without the
    // package installed now RAISES (TASK-860) instead of silently passing audio
    // through.
    id: '80000000-0000-0000-0003-000000000004',
    tenantId: SYSTEM_TENANT_ID,
    name: 'DeepFilterNet3',
    slug: 'deepfilternet3',
    description:
      'DeepFilterNet3 — full-band (48kHz) deep-filtering noise suppression. Stronger suppression than RNNoise at higher compute cost; block-processed (~1s latency) in streaming. Package-resolved checkpoint.',
    category: ModelCategory.AUDIO,
    taskType: ModelTaskType.AUDIO_TO_AUDIO,
    modelType: ModelType.BASE_MODEL,
    source: AiModelSource.LOCAL,
    sourceUri: 'github:Rikorose/DeepFilterNet#DeepFilterNet3',
    sourceRevision: 'main',
    format: AiModelFormat.PYTORCH,
    libraryName: 'deepfilternet',
    servedBy: 'stt',
    deploymentKind: AiDeploymentKind.SELF_HOSTED,
    license: 'mit',
    languages: [],
    availability: AiModelAvailability.NOT_APPLICABLE,
    provider: 'built-in',
    architecture: 'deepfilternet',
    memorySizeMb: 128,
    computeType: 'float32',
    tags: ['noise-reduction', 'full-band', 'dnn'],
  },

  // =========================================================================
  // audio-classification (speaker-embedding) — diarization feature extractors
  // =========================================================================
  {
    id: '80000000-0000-0000-0001-000000000013',
    tenantId: SYSTEM_TENANT_ID,
    name: 'ECAPA-TDNN Speaker Embedding',
    slug: 'ecapa-tdnn-voxceleb',
    description: 'SpeechBrain ECAPA-TDNN speaker-verification embeddings (192-d, ~1.71% EER). Diarization feature extractor.',
    category: ModelCategory.AUDIO,
    taskType: ModelTaskType.SPEAKER_EMBEDDING,
    modelType: ModelType.BASE_MODEL,
    source: AiModelSource.HUGGINGFACE,
    sourceUri: 'speechbrain/spkrec-ecapa-voxceleb',
    sourceRevision: 'main',
    format: AiModelFormat.PYTORCH,
    libraryName: 'speechbrain',
    servedBy: 'stt',
    deploymentKind: AiDeploymentKind.SELF_HOSTED,
    license: 'apache-2.0',
    languages: [],
    provider: 'built-in',
    architecture: 'ecapa-tdnn',
    memorySizeMb: 96,
    computeType: 'float32',
    // 192-d. Since TASK-887 an agent that binds this row for diarization declares its own
    // embedding space: profiles are enrolled with the agent's model and matched only against
    // profiles that model produced (`UserVoiceProfile.modelId`), so no width is load-bearing.
    metaData: { embedding: { dimension: 192 } },
    tags: ['diarization', 'speaker-embedding', 'ecapa'],
  },
  {
    id: '80000000-0000-0000-0001-000000000015',
    tenantId: SYSTEM_TENANT_ID,
    name: 'WeSpeaker ResNet34 Speaker Embedding (pyannote)',
    slug: 'wespeaker-voxceleb-resnet34',
    description: 'pyannote WeSpeaker ResNet34 VoxCeleb speaker-verification embeddings — the SYSTEM ASR template\'s diarization embedding model (TASK-887).',
    category: ModelCategory.AUDIO,
    taskType: ModelTaskType.SPEAKER_EMBEDDING,
    modelType: ModelType.BASE_MODEL,
    source: AiModelSource.HUGGINGFACE,
    sourceUri: 'pyannote/wespeaker-voxceleb-resnet34-LM',
    sourceRevision: 'main',
    format: AiModelFormat.PYTORCH,
    libraryName: 'pyannote-audio',
    servedBy: 'stt',
    deploymentKind: AiDeploymentKind.SELF_HOSTED,
    license: 'cc-by-4.0',
    languages: [],
    provider: 'built-in',
    architecture: 'wespeaker',
    memorySizeMb: 96,
    computeType: 'float32',
    // 256-d — the model the seeded voice profiles were enrolled with (`seed/91-user.ts`,
    // `modelId: 'wespeaker-voxceleb-resnet34'`), and the one the SYSTEM ASR template names
    // (`seed/25-agents.ts`). Descriptive since TASK-887: a profile is matched only by the
    // model that embedded it, so the width no longer gates anything.
    metaData: { embedding: { dimension: 256 } },
    tags: ['diarization', 'speaker-embedding', 'wespeaker', 'default'],
  },

  // =========================================================================
  // token-classification — punctuation restoration, served IN-PROCESS by stt
  // (decision D-4: a network hop inside the realtime transcript path is the
  // wrong trade; the HF task stays token-classification, `servedBy` says who).
  // =========================================================================
  {
    id: '80000000-0000-0000-0004-000000000001',
    tenantId: SYSTEM_TENANT_ID,
    name: 'Cadence Punctuation (1B)',
    slug: 'cadence-punctuation',
    description:
      'ai4bharat/Cadence — 1B punctuation & casing restoration model used by the stt post-processing stage (cadence-punctuation wrapper). Cadence-Fast (270M) is the direct-load variant. Gated Hub repo.',
    category: ModelCategory.NLP,
    taskType: ModelTaskType.TOKEN_CLASSIFICATION,
    modelType: ModelType.BASE_MODEL,
    source: AiModelSource.HUGGINGFACE,
    sourceUri: 'ai4bharat/Cadence',
    sourceRevision: 'main',
    format: AiModelFormat.SAFETENSOR,
    libraryName: 'cadence-punctuation',
    servedBy: 'stt',
    deploymentKind: AiDeploymentKind.SELF_HOSTED,
    license: 'cc-by-4.0',
    gated: true,
    languages: ['en', 'ml', 'hi'],
    provider: 'built-in',
    architecture: null,
    memorySizeMb: 4096,
    computeType: 'float32',
    tags: ['punctuation', 'stt', 'cadence', 'gated'],
  },
];
