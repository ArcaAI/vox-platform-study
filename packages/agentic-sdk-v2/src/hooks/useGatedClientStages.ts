/**
 * @arcaai/vox - the `@arcaai/vox/plugins` client-stage hooks, gated.
 *
 * `plugins.ts` used to re-export `useVAD` / `useSTT` / `useNoiseFilter` straight
 * from their packages. Those are bare pass-throughs: they build their processor
 * and hand it to the track themselves, so `TranscriptionPipeline`'s
 * `clientInference` gate never saw them — a consumer importing from
 * `@arcaai/vox/plugins` got an ungated in-browser model (TASK-977 D-6).
 *
 * These wrappers put them behind the SAME switch. When it is closed the
 * underlying hook is still CALLED (hook order must not depend on config) but it
 * is handed `track: null, autoAttach: false`, which is the only input that can
 * reach `track.setProcessor(...)` — the single point where weights are fetched
 * and the processor is initialised. The actions that would otherwise load a
 * model reject with a typed `AgenticError('CLIENT_INFERENCE_DISABLED')` instead
 * of the underlying hook's vague "No track or processor available".
 *
 * `useSTT` is gated NARROWLY. It is the capture/transport surface as well as
 * the local-model surface, and its `provider` defaults to `'remote'` (backend
 * streaming), which is the SUPPORTED path and must keep working untouched. Only
 * `provider: 'local'` — in-browser Whisper — is gated.
 *
 * @deprecated TASK-865 — the three hooks are removed in R4 along with
 * `@arcaai/vad` / `@arcaai/noise-filter` and the local Whisper stage.
 */

import { useCallback, useContext, useMemo, useSyncExternalStore } from 'react';
import { useVAD as useRawVAD, type UseVADOptions, type UseVADReturn } from '@arcaai/vad';
import { useSTT as useRawSTT, type UseSTTOptions, type UseSTTReturn } from '@arcaai/stt';
import { useNoiseFilter as useRawNoiseFilter, type UseNoiseFilterOptions, type UseNoiseFilterReturn } from '@arcaai/noise-filter';
import { AgenticStoreContext } from '../store/agenticStore';
import { clientInferenceDisabledError, isClientInferenceAllowed, warnClientInferenceBlockedOnce } from '../core/clientInferenceGate';

const NO_OP_UNSUBSCRIBE = () => {};

/**
 * Whether the nearest `AgenticProvider` opted in to client-side inference.
 *
 * Reads the host's own `AgenticConfig` through the provider's store — the
 * existing config channel, not a second one. Deliberately does NOT use
 * `useStoreApi()`, which THROWS outside a provider: these three hooks are
 * package pass-throughs a host may legitimately mount without one, and "no
 * provider" must mean "no allow stated", not a crash.
 */
export function useClientInferenceAllowed(): boolean {
  const api = useContext(AgenticStoreContext);

  const subscribe = useCallback((onChange: () => void) => (api ? api.subscribe(onChange) : NO_OP_UNSUBSCRIBE), [api]);
  const getSnapshot = useCallback(() => isClientInferenceAllowed(api?.getState().config), [api]);

  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}

/** Options with every model-loading input neutralised. */
function inertOptions<T extends { track: unknown; autoAttach?: boolean }>(options: T): T {
  return { ...options, track: null, autoAttach: false };
}

/**
 * Voice Activity Detection (in-browser Silero).
 *
 * @deprecated TASK-865 — removed in R4. Inert unless the host sets
 * `audio.clientInference: { allow: true }`; VAD is a server-side decision of the
 * tenant's ASR Agent (`audioFrontEnd.vad`).
 */
export function useVAD(options: UseVADOptions): UseVADReturn {
  const allowed = useClientInferenceAllowed();
  if (!allowed) warnClientInferenceBlockedOnce('useVAD');

  const result = useRawVAD(allowed ? options : inertOptions(options));

  const refuse = useCallback(async (): Promise<never> => {
    throw clientInferenceDisabledError('useVAD');
  }, []);

  return useMemo(() => (allowed ? result : { ...result, attach: refuse }), [allowed, result, refuse]);
}

/**
 * Noise suppression (in-browser RNNoise).
 *
 * @deprecated TASK-865 — removed in R4. Inert unless the host sets
 * `audio.clientInference: { allow: true }`; denoise is a server-side decision of
 * the tenant's ASR Agent (`audioFrontEnd.denoise`).
 */
export function useNoiseFilter(options: UseNoiseFilterOptions): UseNoiseFilterReturn {
  const allowed = useClientInferenceAllowed();
  if (!allowed) warnClientInferenceBlockedOnce('useNoiseFilter');

  const result = useRawNoiseFilter(allowed ? options : inertOptions(options));

  const refuse = useCallback(async (): Promise<never> => {
    throw clientInferenceDisabledError('useNoiseFilter');
  }, []);

  return useMemo(() => (allowed ? result : { ...result, attach: refuse }), [allowed, result, refuse]);
}

/**
 * Speech-to-Text.
 *
 * Only `provider: 'local'` (in-browser Whisper) is gated — the default
 * `'remote'` provider is capture + backend streaming, which is the supported
 * path and passes straight through.
 *
 * @deprecated TASK-865 — removed in R4. Capture with `useArcaAudio` and let the
 * tenant's ASR Agent decide ASR server-side (`audio.start({ agentSlug })`).
 */
export function useSTT(options: UseSTTOptions): UseSTTReturn {
  const allowed = useClientInferenceAllowed();
  // The provider lives on `features` (`STTFeatureFlags`), and defaults to
  // 'remote' (`DEFAULT_FEATURE_FLAGS` in @arcaai/stt) — so an absent provider is
  // the capture/transport path, never a browser model.
  const wantsBrowserModel = options.features?.provider === 'local';
  const blocked = wantsBrowserModel && !allowed;
  if (blocked) warnClientInferenceBlockedOnce('useSTT({ provider: "local" })');

  const result = useRawSTT(blocked ? inertOptions(options) : options);

  const refuse = useCallback(async (): Promise<never> => {
    throw clientInferenceDisabledError('useSTT({ provider: "local" })');
  }, []);

  return useMemo(() => (blocked ? { ...result, attach: refuse, transcribeSegment: refuse } : result), [blocked, result, refuse]);
}
