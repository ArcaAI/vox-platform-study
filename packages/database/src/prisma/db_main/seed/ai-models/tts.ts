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
 * text-to-speech catalogue (TASK-860 — the owner's catalogue, exactly): two
 * local engines and two cloud vendors, with their admin-selectable voice
 * bindings in `metaData.voices` (`seedAiModels` re-syncs `metaData` on
 * re-seed so voice catalogs stay current). `indic-f5` (prod NO-GO licence) is
 * retired — see `retired.ts`.
 *
 * TASK-879 — THESE ROWS ARE NOW THE MODEL FACTS THE SPEECH PATH READS. The
 * gateway resolves the tenant's TEXT_TO_SPEECH agent, folds the bound row into a
 * `ResolvedTtsSpec` and pushes it with every synthesis request, so a value here
 * reaches `apps/tts` directly instead of being restated as a settings key:
 *
 *   `sourceUri`  the provider-native model id on the wire — what
 *                `tts.sarvam.model` ('bulbul:v3'), `tts.indicParler.hfModel` and
 *                `tts.indicF5.hfModel` used to hold.
 *   the mount path  the ungated internal mirror — `tts.{indicParler,indicF5}.modelPath`.
 *                DERIVED from `bucketPrefix` at resolve time since TASK-890 dropped the
 *                stored column, and never seeded: no bucket identity means "pull from
 *                the Hub", exactly as the retired keys' empty defaults did.
 *   `metaData.artifacts`
 *                auxiliary loader paths beside the weights — today only
 *                `descEncoderPath` (the Parler description tokenizer, formerly
 *                `tts.indicParler.descEncoderPath`). Same deployment-specific
 *                rule: the SHAPE is contract, the value is an operator's.
 *   `metaData.voices[]`
 *                the selectable voices an agent's `parameters.voice` names. A
 *                voice-CLONE engine's reference recording rides HERE, on the
 *                voice (`refAudioPath` / `refText` — formerly
 *                `tts.indicF5.refAudioPath` / `.refText`), because conditioning
 *                audio is a property of the voice and not of the service.
 *                `providerVoice` is the engine-native name when it differs from
 *                the catalogue id; today none do, so none declare it.
 *
 * `indic-f5`'s four moved keys therefore have a declared home and NO row: the
 * engine stays retired (CC-BY-NC provenance unresolved) and its SYSTEM
 * `AiProviderConnection(tts, indic_f5)` row is seeded DISABLED, so nothing can
 * bind or route to it. Re-seeding the row later needs no contract change.
 */
export const TTS_AI_MODELS: AiModelSeed[] = [
  {
    // hexgrad/Kokoro-82M — the `kokoro` package's KPipeline. TASK-860 moves the
    // provider to explicit `KModel(config, model)` + voice `.pt` paths under
    // the published bucket prefix, so it no longer depends on HF_HOME.
    id: '80000000-0000-0000-0007-000000000013',
    tenantId: SYSTEM_TENANT_ID,
    name: 'Kokoro',
    slug: 'kokoro',
    description: 'hexgrad/Kokoro-82M — local PyTorch TTS engine (54 voices), fast English synthesis on CPU. Platform default for text-to-speech.',
    category: ModelCategory.AUDIO,
    taskType: ModelTaskType.TEXT_TO_SPEECH,
    modelType: ModelType.BASE_MODEL,
    source: AiModelSource.HUGGINGFACE,
    sourceUri: 'hexgrad/Kokoro-82M',
    sourceRevision: 'main',
    format: AiModelFormat.PYTORCH,
    libraryName: 'kokoro',
    servedBy: 'tts',
    deploymentKind: AiDeploymentKind.SELF_HOSTED,
    license: 'apache-2.0',
    languages: ['en'],
    isPlatformDefaultFor: [AiTaskKind.TEXT_TO_SPEECH],
    provider: 'built-in',
    architecture: 'kokoro',
    memorySizeMb: 512,
    computeType: 'float32',
    tags: ['tts', 'local', 'default'],
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
    // Gated Hub weights (click-through licence) — the publisher needs the
    // SYSTEM `model-registry:huggingface` token and the accepted licence
    // (OD-7). Served by the `[indic-parler]` image variant.
    id: '80000000-0000-0000-0007-000000000015',
    tenantId: SYSTEM_TENANT_ID,
    name: 'Indic Parler TTS',
    slug: 'indic-parler-tts',
    description: 'AI4Bharat Indic Parler-TTS — local Malayalam synthesis (parler-tts). Gated Hub weights; served by the tts `[indic-parler]` image variant.',
    category: ModelCategory.AUDIO,
    taskType: ModelTaskType.TEXT_TO_SPEECH,
    modelType: ModelType.BASE_MODEL,
    source: AiModelSource.HUGGINGFACE,
    sourceUri: 'ai4bharat/indic-parler-tts',
    sourceRevision: 'main',
    format: AiModelFormat.SAFETENSOR,
    libraryName: 'parler-tts',
    servedBy: 'tts',
    deploymentKind: AiDeploymentKind.SELF_HOSTED,
    license: 'apache-2.0',
    gated: true,
    baseModel: 'parler-tts/parler-tts-mini-v1',
    languages: ['ml', 'en', 'hi', 'ta', 'te', 'kn'],
    provider: 'built-in',
    architecture: 'parler-tts',
    memorySizeMb: 4096,
    computeType: 'float16',
    tags: ['tts', 'local', 'gated', 'malayalam'],
    metaData: {
      ttsProvider: 'indic_parler',
      voices: [{ id: 'Anjali', locale: 'ml-IN' }],
    },
  },
  {
    id: '80000000-0000-0000-0007-000000000012',
    tenantId: SYSTEM_TENANT_ID,
    name: 'Azure Neural Voices',
    slug: 'azure-neural-voices',
    description: 'Azure Cognitive Services neural TTS voices (cloud). Credentials via the tenant → SYSTEM `tts`/`azure` provider connection.',
    category: ModelCategory.AUDIO,
    taskType: ModelTaskType.TEXT_TO_SPEECH,
    modelType: ModelType.BASE_MODEL,
    source: AiModelSource.LOCAL,
    sourceUri: 'azure://neural-voices',
    sourceRevision: 'main',
    format: AiModelFormat.AZURE_SPEECH,
    libraryName: 'azure-speech',
    servedBy: 'tts',
    deploymentKind: AiDeploymentKind.CLOUD,
    wireModelId: 'azure://neural-voices',
    languages: ['en', 'ml'],
    availability: AiModelAvailability.NOT_APPLICABLE,
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
    id: '80000000-0000-0000-0007-000000000014',
    tenantId: SYSTEM_TENANT_ID,
    name: 'Sarvam Bulbul',
    slug: 'sarvam-bulbul',
    description: 'Sarvam Bulbul v3 cloud TTS — Indic-language synthesis (Malayalam). API key via the tenant → SYSTEM `tts`/`sarvam` provider connection.',
    category: ModelCategory.AUDIO,
    taskType: ModelTaskType.TEXT_TO_SPEECH,
    modelType: ModelType.BASE_MODEL,
    source: AiModelSource.LOCAL,
    sourceUri: 'bulbul:v3',
    sourceRevision: 'main',
    format: AiModelFormat.CLOUD_API,
    libraryName: 'sarvam',
    servedBy: 'tts',
    deploymentKind: AiDeploymentKind.CLOUD,
    wireModelId: 'bulbul:v3',
    languages: ['ml', 'en', 'hi', 'ta', 'te', 'kn'],
    availability: AiModelAvailability.NOT_APPLICABLE,
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
];
