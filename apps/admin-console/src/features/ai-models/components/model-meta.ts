/**
 * Display metadata for the gateway model enums (frame 15): human labels for
 * sources ("providers" in the frame) and the closed option lists the
 * register/edit form and filter selects render.
 */

import type { AiModelFormat, AiModelSource, ModelCategory, ModelType } from '../api/types';

export const SOURCE_LABELS: Record<AiModelSource, string> = {
    HUGGINGFACE: 'Hugging Face',
    GITHUB: 'GitHub',
    MLFLOW: 'MLflow',
    LOCAL: 'Local',
};

export const SOURCE_OPTIONS: AiModelSource[] = ['HUGGINGFACE', 'GITHUB', 'MLFLOW', 'LOCAL'];

export const CATEGORY_OPTIONS: ModelCategory[] = ['MULTI_MODAL', 'VISION', 'NLP', 'AUDIO', 'TABULAR', 'UNKNOWN'];

export const MODEL_TYPE_OPTIONS: ModelType[] = ['BASE_MODEL', 'FINETUNED_MODEL', 'QUANTIZED_MODEL', 'UNKNOWN'];

export const FORMAT_OPTIONS: AiModelFormat[] = ['SAFETENSOR', 'ONNX', 'NEMO', 'PYTORCH', 'CTRANSLATE2', 'FASTER_WHISPER', 'MLX', 'GGUF'];

/** Canonical runtime provider ids (TASK-506; mirrors AI_MODEL_PROVIDERS in @arcaai/applications). */
export const RUNTIME_PROVIDER_OPTIONS = ['ollama', 'lm-studio', 'azure', 'bedrock', 'built-in', 'sarvam'] as const;

/** "AUTOMATIC_SPEECH_RECOGNITION" -> "automatic speech recognition". */
export function humanizeEnum(value: string): string {
    return value.replaceAll('_', ' ').toLowerCase();
}
