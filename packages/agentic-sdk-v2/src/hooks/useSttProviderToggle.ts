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
 * Degraded posture: `activePipeline` stays `null` for a non-backend (local)
 * session, so both switch methods reject cleanly instead of no-op'ing.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useArcaAudio } from './useArcaAudio';

type ProviderSwitchTarget = 'primary' | 'fallback';

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

  const [switchStatus, setSwitchStatus] = useState<'idle' | 'switching' | 'switched' | 'failed'>('idle');

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
      const current = audio.activePipeline ?? null;
      // No live backend session / no pipeline to switch from.
      if (!current) {
        throw new Error(`No active streaming session to switch to ${target}`);
      }
      const isCurrentlyFallback = current.isFallback === true;
      const alreadyThere = target === 'fallback' ? isCurrentlyFallback : !isCurrentlyFallback;
      // Already on the requested side → idempotent no-op (no duplicate v2 call).
      if (alreadyThere) {
        setSwitchStatus('switched');
        return;
      }
      setSwitchStatus('switching');
      try {
        await audio.switchProvider(target);
        // Success is confirmed asynchronously by the backend `provider_switched`
        // frame, which the effect above turns into 'switched'.
      } catch (err) {
        setSwitchStatus('failed');
        throw err;
      }
    },
    [audio],
  );

  const switchToPipeline = useCallback(() => switchTo('primary'), [switchTo]);
  const switchToDefault = useCallback(() => switchTo('fallback'), [switchTo]);

  return {
    activeProvider: activePipeline ? { pipelineId: activePipeline.id, name: activePipeline.name, isFallback: activePipeline.isFallback } : null,
    usePipeline: !(activePipeline?.isFallback === true),
    isFallbackActive: activePipeline?.isFallback === true,
    switchStatus,
    switchToPipeline,
    switchToDefault,
  };
}
