/**
 * @arcaai/vox - the client-inference gate, in one place.
 *
 * TASK-865 established the rule: the browser CAPTURES audio and RENDERS results,
 * it never runs a model. `TranscriptionPipeline` enforces it for the two stages
 * it owns — its gate helper is literally typed `(stage: 'noiseFilter' | 'vad')`.
 *
 * TASK-977 (D-6) extends the SAME switch to the browser-model surfaces that sit
 * OUTSIDE the pipeline and therefore never met that gate:
 *   - `useLocalVoiceEmbedding` (WavLM speaker verification — the "voice
 *     embedding for diarization" the owner directive names), and
 *   - the raw `useVAD` / `useSTT({ provider: 'local' })` / `useNoiseFilter`
 *     re-exports on `@arcaai/vox/plugins`.
 *
 * There is one switch and one predicate, so "is client inference allowed" can
 * only ever have one answer: `audio.clientInference: { allow: true }` on the
 * host's `AgenticConfig`. Anything else — including no config at all — is
 * CLOSED. The pipeline keeps reading the flattened copy on its own
 * `TranscriptionPipelineConfig`; `PluginManager` is what forwards one to the
 * other.
 */

import { AgenticError } from '../types/common';

/** The narrowest shape this predicate needs — so it can read a partial config. */
interface ClientInferenceConfigHost {
  audio?: { clientInference?: { allow?: boolean } | undefined } | undefined;
}

/**
 * Whether the host explicitly opted in to CLIENT-SIDE model inference.
 *
 * Fails CLOSED: a missing config, a missing `audio`, a missing
 * `clientInference` and an `allow` that is anything but the boolean `true` all
 * answer `false`.
 */
export function isClientInferenceAllowed(config: ClientInferenceConfigHost | null | undefined): boolean {
  return config?.audio?.clientInference?.allow === true;
}

/**
 * The refusal. Typed so a caller can branch on `code` instead of matching a
 * message, and worded so the host can find the switch that turns it on.
 *
 * @param surface what the caller asked for, e.g. `useLocalVoiceEmbedding`.
 */
export function clientInferenceDisabledError(surface: string): AgenticError {
  return new AgenticError(
    'CLIENT_INFERENCE_DISABLED',
    `${surface} runs a model in the browser, which is disabled. The browser captures audio and renders results; ` +
      "VAD, denoise, diarization and ASR are decided server-side by the tenant's ASR Agent. To opt in during the " +
      'deprecation window, set audio.clientInference: { allow: true } (itself deprecated; removed in R4).',
    { context: { surface } },
  );
}

/** Warn once per page load per surface, mirroring the pipeline's warn-once. */
const warnedSurfaces = new Set<string>();

export function warnClientInferenceBlockedOnce(surface: string): void {
  if (warnedSurfaces.has(surface)) return;
  warnedSurfaces.add(surface);
  console.warn(
    `[@arcaai/vox] ${surface} is inert: client-side model inference is off. ` +
      'Set audio.clientInference: { allow: true } to opt in (deprecated, removed in R4).',
  );
}
