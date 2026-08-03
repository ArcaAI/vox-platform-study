'use client';

/**
 * @arcaai/vox - useSttProviderToggle (TASK-586 Lane H)
 *
 * The NATIVE (non-compat) end-user affordance for the 2-way runtime STT
 * provider toggle: pipeline (primary) ↔ default (fallback). It gives a v2 app
 * the same "switch transcription provider" control flow the compat
 * `useArcaSttProvider` gives a migrated v1 app, but WITHOUT requiring
 * `<ArcaCompatProvider>` — it is a thin adapter over the public v2 surface
 * `useArcaAudio()` already exposes (`activePipeline`, `switchProvider()`).
 *
 * Both directions now hit the NATIVE streaming routes: `switchToPipeline()`
 * POSTs `.../switch-to-primary` and `switchToDefault()` POSTs
 * `.../switch-to-fallback` (see `StreamingSessionManager.switchProvider`). No
 * compat shim, no feature flag. The backend swaps the ASR engine while the
 * WebSocket/session survive; the resulting pipeline is learned asynchronously
 * from the `provider_switched` status frame, which flips
 * `audio.activePipeline.isFallback` — the single source of truth this hook
 * reads for `activeProvider` / `usePipeline`.
 *
 * Degraded posture (TASK-614): a switch is possible whenever CAPTURE is running.
 * Before capture, both methods reject with `AgenticError('SWITCH_UNSUPPORTED')`.
 * During capture on a local (browser) STT session there is no backend session to
 * switch, and the rejection comes from `useArcaAudio.switchProvider` — either
 * way the call rejects rather than silently resolving. `activePipeline` is NOT
 * the gate: it is request-derived and null for the whole session whenever the
 * app started capture without an explicit `pipelineId`.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { AgenticError } from '../types/common';
import { STT_ENDPOINTS } from '../core/constants';
import { useAgenticStore } from '../store';
import { useArcaAudio } from './useArcaAudio';

type ProviderSwitchTarget = 'primary' | 'fallback';

/**
 * The tenant's configured fallback pipeline (TASK-604), read from
 * `GET /audio/transcription-jobs/fallback`.
 *
 * Without it a UI can only render an unlabelled "Default" and the user finds
 * out that no fallback exists from a 409 in the middle of a consultation.
 * Identity only — no credential material crosses this boundary.
 */
export interface SttFallbackProvider {
  configured: boolean;
  pipelineId: string | null;
  pipelineName: string | null;
}

export interface UseSttProviderToggleReturn {
  /** Pipeline currently transcribing (null before capture / for local STT). */
  activeProvider: { pipelineId: string; name?: string; isFallback: boolean } | null;
  /**
   * True when transcribing on the SDK-configured (primary) pipeline; false when
   * on the tenant-admin default (fallback). `true` before any capture session
   * exists (primary is the nominal state).
   */
  usePipeline: boolean;
  /** True when the session is currently on the tenant-admin default (fallback). */
  isFallbackActive: boolean;
  /** Lifecycle of the most recent user-requested switch. */
  switchStatus: 'idle' | 'switching' | 'switched' | 'failed';
  /**
   * The last switch failure, or `null`. Exposed so a UI can render the reason
   * (typically "no fallback configured for this tenant") without wrapping every
   * call site in try/catch. The methods still reject — this is additive.
   */
  switchError: Error | null;
  /** Return the control to `idle` and drop `switchError` (dismiss a banner). */
  resetSwitchStatus: () => void;
  /**
   * The tenant's configured fallback pipeline, or `null` while unknown (not yet
   * loaded, or the lookup failed). `null` is UNKNOWN, never "none configured".
   */
  fallback: SttFallbackProvider | null;
  /**
   * Whether `switchToDefault()` can succeed right now: a live session exists,
   * it is not already on the fallback, and a fallback is configured (or is
   * unknown — an unreadable lookup must not take the option away).
   */
  canSwitchToDefault: boolean;
  /** Re-read the fallback pointer (e.g. after a tenant admin changes it). */
  refreshFallback: () => Promise<void>;
  /**
   * Switch (back) to the SDK-configured primary pipeline (native route).
   * Idempotent — a call while already on the primary resolves without a second
   * v2 call. Rejects when there is no live streaming session to switch, or with
   * the backend error when the switch fails.
   */
  switchToPipeline: () => Promise<void>;
  /**
   * Switch to the tenant-admin default (fallback) provider (native route).
   * Idempotent — a call while already on the fallback resolves without a second
   * v2 call. Rejects when there is no live streaming session to switch, or with
   * the backend error when the switch fails.
   */
  switchToDefault: () => Promise<void>;
}

export function useSttProviderToggle(): UseSttProviderToggleReturn {
  const audio = useArcaAudio();
  const activePipeline = audio.activePipeline ?? null;
  const store = useAgenticStore();
  const apiClient = store.apiClient;

  const [switchStatus, setSwitchStatus] = useState<'idle' | 'switching' | 'switched' | 'failed'>('idle');
  const [switchError, setSwitchError] = useState<Error | null>(null);
  const [fallback, setFallback] = useState<SttFallbackProvider | null>(null);

  /**
   * Read the fallback pointer. Failure leaves `fallback` at `null` (unknown)
   * rather than surfacing an error: this is a labelling aid, and the switch
   * route remains the authority on whether a fallback exists.
   */
  const refreshFallback = useCallback(async (): Promise<void> => {
    if (!apiClient) return;
    try {
      const data = await apiClient.get<SttFallbackProvider>(STT_ENDPOINTS.FALLBACK_PROVIDER);
      setFallback({
        configured: data?.configured === true,
        pipelineId: data?.pipelineId ?? null,
        pipelineName: data?.pipelineName ?? null,
      });
    } catch {
      setFallback(null);
    }
  }, [apiClient]);

  useEffect(() => {
    void refreshFallback();
  }, [refreshFallback]);

  // Detect the fallback flip (in EITHER direction) so a completed switch —
  // confirmed asynchronously by the backend `provider_switched` frame — moves
  // the status to 'switched'.
  const prevIsFallbackRef = useRef<boolean>(activePipeline?.isFallback ?? false);
  useEffect(() => {
    const isFallback = activePipeline?.isFallback ?? false;
    if (activePipeline && isFallback !== prevIsFallbackRef.current) {
      setSwitchStatus('switched');
    }
    prevIsFallbackRef.current = isFallback;
  }, [activePipeline]);

  const switchTo = useCallback(
    async (target: ProviderSwitchTarget): Promise<void> => {
      // Whether a switch is POSSIBLE is decided by capture, not by
      // `activePipeline` (TASK-614 D-3). `activePipeline` is request-derived —
      // null for the whole session whenever capture started without an explicit
      // `pipelineId` — so gating on it refused switches on live sessions.
      if (!audio.isCapturing) {
        throw new AgenticError('SWITCH_UNSUPPORTED', `No active capture session — start capture before switching to ${target}.`);
      }
      const current = audio.activePipeline ?? null;
      // Which side we are on is a SEPARATE question, and one the client may not
      // be able to answer yet. Skip the idempotence shortcut when it is unknown
      // and let the backend adjudicate rather than assuming either side.
      if (current) {
        const isCurrentlyFallback = current.isFallback === true;
        const alreadyThere = target === 'fallback' ? isCurrentlyFallback : !isCurrentlyFallback;
        // Already on the requested side → idempotent no-op (no duplicate v2 call).
        if (alreadyThere) {
          setSwitchStatus('switched');
          return;
        }
      }
      setSwitchStatus('switching');
      setSwitchError(null);
      try {
        await audio.switchProvider(target);
        // Success is confirmed asynchronously by the backend `provider_switched`
        // frame, which the effect above turns into 'switched'.
      } catch (err) {
        setSwitchStatus('failed');
        setSwitchError(err instanceof Error ? err : new Error(String(err)));
        throw err;
      }
    },
    [audio],
  );

  const switchToPipeline = useCallback(() => switchTo('primary'), [switchTo]);
  const switchToDefault = useCallback(() => switchTo('fallback'), [switchTo]);

  const resetSwitchStatus = useCallback(() => {
    setSwitchStatus('idle');
    setSwitchError(null);
  }, []);

  // `fallback === null` is UNKNOWN, so it does NOT block the control — removing
  // a user's fallback because a labelling read failed would be worse than
  // letting the switch route answer for itself.
  const canSwitchToDefault = activePipeline !== null && activePipeline.isFallback !== true && fallback?.configured !== false;

  return {
    activeProvider: activePipeline ? { pipelineId: activePipeline.id, name: activePipeline.name, isFallback: activePipeline.isFallback } : null,
    usePipeline: !(activePipeline?.isFallback === true),
    isFallbackActive: activePipeline?.isFallback === true,
    switchStatus,
    switchError,
    resetSwitchStatus,
    fallback,
    canSwitchToDefault,
    refreshFallback,
    switchToPipeline,
    switchToDefault,
  };
}
