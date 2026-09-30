import { ModelTaskType } from '@arcaai/domains';
import type { LocalModelPreview } from '@arcaai/types';
import { deriveLocalPath, derivedLocalPath, HOPE_MODELS_BUCKET, SINGLE_FILE_LIBRARIES } from '../constants';
import { formatFor, servedByFor, suggestedSlugFor } from './hub-preview.util';

/**
 * Pure derivations behind `GET admin/ai-models/local/preview` (TASK-1023 R4c): what a prefix in
 * the models bucket holds, read from the objects themselves — never typed by an admin.
 *
 * Every key handed to these helpers is RELATIVE to the bucket prefix being previewed, the same
 * frame `primaryObject` is stored in.
 */

/** One object under the previewed prefix, its key relative to that prefix. */
export interface LocalModelFile {
  key: string;
  size: number;
}

const HF_SNAPSHOT = /^hf\/hub\/models--([^/]+?)--([^/]+)\/snapshots\/([^/]+)\/$/;
const HF_REPO_DIR = /^hf\/hub\/models--[^/]+\/$/;
const MANIFEST_OBJECT = 'manifest.json';
export const LOCAL_CONFIG_OBJECT = 'config.json';

/** The file a single-file loader opens, per library. `parakeet.cpp` has no pattern: name the file. */
const SINGLE_FILE_PATTERN: Readonly<Record<string, RegExp>> = {
  'llama.cpp': /\.gguf$/i,
  'whisper.cpp': /(^|\/)ggml[^/]*\.bin$/i,
  onnxruntime: /\.onnx$/i,
};

/** `hf/hub/models--<org>--<name>/snapshots/<sha>/` → the repo id and the snapshot sha. */
export function parseHfSnapshotPrefix(prefix: string): { repoId: string; revision: string } | null {
  const match = HF_SNAPSHOT.exec(prefix);
  return match ? { repoId: `${match[1]}/${match[2]}`, revision: match[3] } : null;
}

/** Whether `prefix` is an HF cache REPO directory (above its snapshots). */
export function isHfRepoDirPrefix(prefix: string): boolean {
  return HF_REPO_DIR.test(prefix);
}

const has = (files: LocalModelFile[], pattern: RegExp) => files.some((f) => pattern.test(f.key));

/** The serving library the files imply. `config.json` with `architectures` + torch weights = transformers. */
export function localLibraryFor(files: LocalModelFile[], config: Record<string, unknown> | null): string | null {
  if (has(files, SINGLE_FILE_PATTERN['llama.cpp'])) return 'llama.cpp';
  if (has(files, SINGLE_FILE_PATTERN['whisper.cpp'])) return 'whisper.cpp';
  if (has(files, /\.nemo$/i)) return 'nemo';
  if (architectureOf(config) && has(files, /\.(safetensors|bin|pt|pth)$/i)) return 'transformers';
  if (has(files, SINGLE_FILE_PATTERN.onnxruntime)) return 'onnxruntime';
  return null;
}

function architectureOf(config: Record<string, unknown> | null): string | null {
  const archs = config?.architectures;
  return Array.isArray(archs) && typeof archs[0] === 'string' && archs[0].length > 0 ? archs[0] : null;
}

/** `config.json` `torch_dtype` (or the newer `dtype`), when it is a plain string. */
function computeTypeOf(config: Record<string, unknown> | null): string | null {
  const dtype = config?.torch_dtype ?? config?.dtype;
  return typeof dtype === 'string' && dtype.length > 0 && dtype.length <= 50 ? dtype : null;
}

/**
 * The registry task. From the transformers class name when there is one (conservative — only heads
 * whose task is unambiguous), else from the single-file library (ggml → speech, GGUF → text
 * generation). `null` = not inferable.
 */
export function localTaskFor(library: string | null, config: Record<string, unknown> | null): ModelTaskType | null {
  const arch = architectureOf(config);
  if (arch) {
    if (/ForTokenClassification$/.test(arch)) return ModelTaskType.TOKEN_CLASSIFICATION;
    if (/ForSequenceClassification$/.test(arch)) return ModelTaskType.TEXT_CLASSIFICATION;
    if (/ForQuestionAnswering$/.test(arch)) return ModelTaskType.QUESTION_ANSWERING;
    if (/ForMaskedLM$/.test(arch)) return ModelTaskType.FILL_MASK;
    if (/ForCausalLM$/.test(arch)) return ModelTaskType.TEXT_GENERATION;
    if (/ForAudioClassification$/.test(arch)) return ModelTaskType.AUDIO_CLASSIFICATION;
    if (/ForSpeechSeq2Seq$|ForCTC$|^Whisper\w*ForConditionalGeneration$/.test(arch)) return ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION;
  }
  if (library === 'whisper.cpp') return ModelTaskType.AUTOMATIC_SPEECH_RECOGNITION;
  if (library === 'llama.cpp') return ModelTaskType.TEXT_GENERATION;
  return null;
}

/**
 * The single file a single-file loader opens: the file the admin pointed at, else the ONE file
 * matching the library's pattern. Several candidates → `null` (the admin points at the file).
 * A multi-file library has no primary object.
 */
export function primaryObjectFor(library: string | null, files: LocalModelFile[], namedFile: string | null): string | null {
  if (!library || !SINGLE_FILE_LIBRARIES.has(library)) return null;
  if (namedFile) return namedFile;
  const pattern = SINGLE_FILE_PATTERN[library];
  if (!pattern) return null;
  const candidates = files.filter((f) => pattern.test(f.key));
  return candidates.length === 1 ? candidates[0].key : null;
}

/** `s3://hope-models/<prefix>` — the LOCAL row's `sourceUri`, the console's `deriveLocalSourceUri` rule. */
export function localSourceUriFor(bucketPrefix: string): string {
  return `s3://${HOPE_MODELS_BUCKET}/${bucketPrefix.replace(/^\/+/, '').replace(/\/+$/, '')}`;
}

/** The full preview for one bucket prefix (trailing slash) and the objects under it. */
export function buildLocalModelPreview(input: {
  bucketPrefix: string;
  files: LocalModelFile[];
  config: Record<string, unknown> | null;
  namedFile: string | null;
}): LocalModelPreview {
  const { bucketPrefix, config, namedFile } = input;
  const files = input.files.filter((f) => f.key.length > 0 && !f.key.endsWith('/'));
  const snapshot = parseHfSnapshotPrefix(bucketPrefix);
  const layout: LocalModelPreview['layout'] = snapshot ? 'hf-cache' : files.some((f) => f.key === MANIFEST_OBJECT) ? 'flat' : 'files';

  const libraryName = localLibraryFor(files, config);
  const taskType = localTaskFor(libraryName, config);
  const primaryObject = primaryObjectFor(libraryName, files, namedFile);

  const segments = bucketPrefix.replace(/\/+$/, '').split('/');
  // hf-cache → the repo name; flat (`<slug>/<version>/`) → the slug segment; else the folder name.
  const nameSource = snapshot
    ? (snapshot.repoId.split('/').pop() ?? snapshot.repoId)
    : layout === 'flat'
      ? segments[0]
      : segments[segments.length - 1];

  return {
    bucketPrefix,
    localPath: derivedLocalPath({ bucketPrefix, primaryObject, libraryName }) ?? deriveLocalPath(bucketPrefix),
    primaryObject,
    layout,
    files,
    totalBytes: files.reduce((sum, f) => sum + (Number.isFinite(f.size) ? f.size : 0), 0),
    revision: snapshot?.revision ?? null,
    suggested: {
      slug: suggestedSlugFor(nameSource),
      name: nameSource,
      taskType,
      libraryName,
      format: formatFor(
        libraryName,
        files.map((f) => ({ path: f.key })),
      ),
      servedBy: servedByFor(taskType, libraryName),
      architecture: architectureOf(config),
      computeType: computeTypeOf(config),
    },
  };
}
