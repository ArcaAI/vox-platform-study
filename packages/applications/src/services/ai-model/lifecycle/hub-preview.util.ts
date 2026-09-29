import { AiModelFormat, ModelCategory, ModelTaskType, ModelType } from '@arcaai/domains';
import { AI_MODEL_LIBRARIES, HF_CACHE_LIBRARIES, MODEL_TASK_TYPE_TO_PIPELINE_TAG } from '../constants';
import type { HuggingFaceFileEntry, HuggingFaceRepoInfo } from '../publish/huggingface-model-source.client';

/** How the publisher lays a repo out in the bucket (the processor's own split, `HF_CACHE_LIBRARIES`). */
export type HubPublishLayout = 'hf-cache' | 'flat';

/** What `GET admin/ai-models/hub/preview` answers: the Hub card, plus the registry fields it suggests. */
export interface HubModelPreview {
  repoId: string;
  revision: string;
  commitSha: string;
  sourceUri: string;
  pipelineTag: string | null;
  libraryName: string | null;
  license: string | null;
  gated: boolean;
  languages: string[];
  baseModel: string | null;
  totalBytes: number;
  fileCount: number;
  files: HuggingFaceFileEntry[];
  /** The registry task inferred from `pipelineTag` (the `ModelTaskType` member), or null. */
  taskType: ModelTaskType | null;
  suggestedSlug: string;
  suggestedName: string;
  suggestedFormat: AiModelFormat | null;
  /** How the publisher will lay the weights out in the bucket. */
  layout: HubPublishLayout;
  /** The remaining registry fields the card suggests; null where nothing could be inferred. */
  suggested: {
    category: ModelCategory | null;
    modelType: ModelType | null;
    libraryName: string | null;
    servedBy: string | null;
    provider: string | null;
  };
}

/** HOPE-specific task members that borrow a Hub tag — never inferred FROM that tag. */
const BORROWED_TAGS: ReadonlySet<ModelTaskType> = new Set([
  ModelTaskType.GUARDRAIL,
  ModelTaskType.SPEAKER_DIARIZATION,
  ModelTaskType.SPEAKER_EMBEDDING,
  ModelTaskType.UNKNOWN,
]);

const AUDIO_TASKS: ReadonlySet<ModelTaskType> = new Set([
  ModelTaskType.TEXT_TO_SPEECH,
  ModelTaskType.TEXT_TO_AUDIO,
  ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
  ModelTaskType.AUDIO_TO_AUDIO,
  ModelTaskType.AUDIO_CLASSIFICATION,
  ModelTaskType.VOICE_ACTIVITY_DETECTION,
  ModelTaskType.SPEAKER_DIARIZATION,
  ModelTaskType.SPEAKER_EMBEDDING,
]);
const NLP_TASKS: ReadonlySet<ModelTaskType> = new Set([
  ModelTaskType.TEXT_CLASSIFICATION,
  ModelTaskType.TOKEN_CLASSIFICATION,
  ModelTaskType.TABLE_QUESTION_ANSWERING,
  ModelTaskType.QUESTION_ANSWERING,
  ModelTaskType.ZERO_SHOT_CLASSIFICATION,
  ModelTaskType.TRANSLATION,
  ModelTaskType.SUMMARIZATION,
  ModelTaskType.FEATURE_EXTRACTION,
  ModelTaskType.TEXT_GENERATION,
  ModelTaskType.TEXT2TEXT_GENERATION,
  ModelTaskType.FILL_MASK,
  ModelTaskType.SENTENCE_SIMILARITY,
  ModelTaskType.GUARDRAIL,
]);
const TABULAR_TASKS: ReadonlySet<ModelTaskType> = new Set([
  ModelTaskType.TABULAR_CLASSIFICATION,
  ModelTaskType.TABULAR_REGRESSION,
  ModelTaskType.TIME_SERIES_FORECASTING,
]);
const MULTI_MODAL_TASKS: ReadonlySet<ModelTaskType> = new Set([
  ModelTaskType.IMAGE_TEXT_TO_TEXT,
  ModelTaskType.VISUAL_QUESTION_ANSWERING,
  ModelTaskType.DOCUMENT_QUESTION_ANSWERING,
  ModelTaskType.VIDEO_TEXT_TO_TEXT,
  ModelTaskType.ANY_TO_ANY,
]);
const STT_TASKS: ReadonlySet<ModelTaskType> = new Set([
  ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION,
  ModelTaskType.VOICE_ACTIVITY_DETECTION,
  ModelTaskType.SPEAKER_DIARIZATION,
  ModelTaskType.SPEAKER_EMBEDDING,
  ModelTaskType.AUDIO_TO_AUDIO,
]);

const KNOWN_LIBRARIES: ReadonlySet<string> = new Set<string>(AI_MODEL_LIBRARIES);

/** The Hub `pipeline_tag` → the registry task, the inverse of `MODEL_TASK_TYPE_TO_PIPELINE_TAG`. */
export function taskTypeFromPipelineTag(tag: string | null): ModelTaskType | null {
  if (!tag) return null;
  for (const task of Object.values(ModelTaskType)) {
    if (BORROWED_TAGS.has(task)) continue;
    if (MODEL_TASK_TYPE_TO_PIPELINE_TAG[task] === tag) return task;
  }
  return null;
}

export function categoryOf(task: ModelTaskType | null): ModelCategory | null {
  if (!task) return null;
  if (AUDIO_TASKS.has(task)) return ModelCategory.AUDIO;
  if (NLP_TASKS.has(task)) return ModelCategory.NLP;
  if (TABULAR_TASKS.has(task)) return ModelCategory.TABULAR;
  if (MULTI_MODAL_TASKS.has(task)) return ModelCategory.MULTI_MODAL;
  return ModelCategory.VISION;
}

/** `blaze999/Medical-NER` → `medical-ner`: the repo NAME, in the registry's slug grammar. */
export function suggestedSlugFor(repoId: string): string {
  const name = repoId.split('/').pop() ?? repoId;
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 100)
    .replace(/-+$/g, '');
  return slug.length >= 2 ? slug : `model-${slug || 'x'}`;
}

const ext = (path: string) => path.toLowerCase();

function libraryFor(hubLibrary: string | null, task: ModelTaskType | null, files: HuggingFaceFileEntry[]): string | null {
  if (hubLibrary && KNOWN_LIBRARIES.has(hubLibrary)) return hubLibrary;
  const paths = files.map((f) => ext(f.path));
  if (paths.some((p) => p.endsWith('.gguf'))) return 'llama.cpp';
  if (task === ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION && paths.some((p) => /(^|\/)ggml[^/]*\.bin$/.test(p))) return 'whisper.cpp';
  if (paths.some((p) => p.endsWith('.onnx'))) return 'onnxruntime';
  return null;
}

function formatFor(library: string | null, files: HuggingFaceFileEntry[]): AiModelFormat | null {
  const paths = files.map((f) => ext(f.path));
  if (paths.some((p) => p.endsWith('.gguf'))) return AiModelFormat.GGUF;
  if (library === 'whisper.cpp') return AiModelFormat.WHISPER_CPP;
  if (library === 'ctranslate2') return AiModelFormat.CTRANSLATE2;
  if (library === 'faster-whisper') return AiModelFormat.FASTER_WHISPER;
  if (paths.some((p) => p.endsWith('.nemo'))) return AiModelFormat.NEMO;
  if (paths.some((p) => p.endsWith('.onnx'))) return AiModelFormat.ONNX;
  if (paths.some((p) => p.endsWith('.safetensors'))) return AiModelFormat.SAFETENSOR;
  if (paths.some((p) => p.endsWith('.bin') || p.endsWith('.pt') || p.endsWith('.pth'))) return AiModelFormat.PYTORCH;
  return null;
}

function servedByFor(task: ModelTaskType | null, library: string | null): string | null {
  if (!task) return null;
  if (task === ModelTaskType.TEXT_GENERATION && library === 'llama.cpp') return 'lmstudio';
  if (STT_TASKS.has(task)) return 'stt';
  if (task === ModelTaskType.TEXT_TO_SPEECH || task === ModelTaskType.TEXT_TO_AUDIO) return 'tts';
  if (NLP_TASKS.has(task) && task !== ModelTaskType.TEXT_GENERATION && task !== ModelTaskType.TEXT2TEXT_GENERATION) return 'nlp';
  return null;
}

/**
 * Map a Hub card + file list onto the registry's vocabulary.
 *
 * Every suggestion is a PREFILL, never a decision: a field this cannot infer
 * is `null` and the platform admin supplies it. The layout follows the
 * publisher's own rule — a library that loads through a Hugging Face hub cache
 * is published as one (`hf-cache`), everything else as a flat, content-addressed
 * `<slug>/<version>/` prefix.
 */
export function buildHubPreview(input: {
  repoId: string;
  revision: string;
  info: HuggingFaceRepoInfo & { baseModel?: string | null };
  files: HuggingFaceFileEntry[];
}): HubModelPreview {
  const { repoId, revision, info, files } = input;
  const taskType = taskTypeFromPipelineTag(info.pipelineTag);
  const libraryName = libraryFor(info.libraryName, taskType, files);
  const format = formatFor(libraryName, files);
  const servedBy = servedByFor(taskType, libraryName);
  const quantized = format === AiModelFormat.GGUF || format === AiModelFormat.WHISPER_CPP;

  return {
    repoId,
    revision,
    commitSha: info.sha,
    sourceUri: `hf:${repoId}`,
    pipelineTag: info.pipelineTag,
    libraryName: info.libraryName,
    license: info.license,
    gated: info.gated,
    languages: info.languages,
    baseModel: info.baseModel ?? null,
    totalBytes: files.reduce((sum, f) => sum + (Number.isFinite(f.size) ? f.size : 0), 0),
    fileCount: files.length,
    files,
    taskType,
    suggestedSlug: suggestedSlugFor(repoId),
    suggestedName: repoId.split('/').pop() ?? repoId,
    suggestedFormat: format,
    // The processor's own rule: only a hub-cache library is published as a hub cache.
    layout: libraryName && HF_CACHE_LIBRARIES.has(libraryName) ? 'hf-cache' : 'flat',
    suggested: {
      category: categoryOf(taskType),
      modelType: quantized ? ModelType.QUANTIZED_MODEL : null,
      libraryName,
      servedBy,
      provider: servedBy === 'lmstudio' ? 'lm-studio' : servedBy ? 'built-in' : null,
    },
  };
}
