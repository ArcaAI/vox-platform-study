/**
 * TASK-383 — Platform Monitoring (frame 11) "Models & running tasks" inventory.
 *
 * The grounded list of the real inference models each microservice runs (TASK-371
 * §5.9). Model + host-service identity is REAL; live "running" counts and
 * "avg latency" are TARGET (no per-model inference-telemetry endpoint) and drawn
 * as em-dashes by the page.
 */

export interface PlatformModel {
    /** Stable id (the model identifier, used as the row key + mono label). */
    id: string;
    /** Display name (same as id for these models). */
    name: string;
    /** Host microservice display name (`STT` / `SMR` / `Guardrail` / `NLP`). */
    service: string;
}

/** Real deployed models, in the frame-11 display order. */
export const PLATFORM_MODELS: readonly PlatformModel[] = [
    { id: 'whisper-large-v3-turbo', name: 'whisper-large-v3-turbo', service: 'STT' },
    { id: 'silero-vad-v5', name: 'silero-vad-v5', service: 'STT' },
    { id: 'gemma-4-e4b', name: 'gemma-4-e4b', service: 'SMR' },
    { id: 'granite-guardian-4.1-8b', name: 'granite-guardian-4.1-8b', service: 'Guardrail' },
    { id: 'Medical-NER', name: 'Medical-NER', service: 'NLP' },
    { id: 'symps-disease-bert', name: 'symps-disease-bert', service: 'NLP' },
] as const;
