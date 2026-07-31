'use client';

/**
 * @arcaai/vox/compat - useArcaSttProvider
 *
 * The ONE compat import with NO v1 ancestor (TASK-568 §3 D-1). v1 never had STT
 * provider switching, so this is a compat-NATIVE extension: it lets a migrated
 * v1 app build the "switch transcription provider" control flow with a single
 * hook — no v2 store knowledge, no `useArcaAudio` adoption, no WS awareness.
 *
 * TASK-586 Lane D generalizes the original TASK-567/568 one-way switch into a
 * BIDIRECTIONAL toggle: ON = the SDK-configured pipeline (primary), OFF = the
 * tenant-admin default provider (fallback). `switchToFallback` is kept as an
 * alias of the new `switchToDefault` — every pre-586 caller keeps compiling
 * and behaving exactly as before.
 *
 * It is a THIN adapter over the public v2 surface `useArcaAudio()` provides
 * (`activePipeline`, `sttConnectionState`, `switchProvider()`), so the compat
 * invariant (adapters consume ONLY the public v2 API) holds. It owns no client,
 * no store internals.
 *
 * Notifications:
 *  - `onProviderSwitched` fires on EVERY switch in EITHER direction (auto
 *    outage-driven OR user), derived from the store's `activePipeline.isFallback`
 *    flip (true→false now fires too, not just false→true).
 *  - `onSwitchFailed` fires when a user-requested switch rejects.
 *
 * Degraded posture (deployment predates TASK-567 — no fallback / no switch
 * route): `activePipeline` stays `null` for a non-backend session, so
 * `fallbackAvailable` is `false` and `switchToDefault()`/`switchToPipeline()`
 * reject cleanly — never a crash or a silent no-op resolution. Switching back
 * to the primary pipeline additionally requires `enableProviderSwitch: true`
 * in the `<ArcaCompatProvider>` config (TASK-586 §C3) — without it, the native
 * streaming route has no primary-direction endpoint and `switchToPipeline()`
 * rejects with `SWITCH_FAILED`.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import { useArcaAudio } from '../hooks/useArcaAudio';
import { useAgenticStore } from '../store/agenticStore';
import { useCompatFeatureFlags } from './ArcaCompatProvider';
import type { ErrorInfo, ProviderSwitchInfo } from './types';

type ProviderSwitchTarget = 'primary' | 'fallback';

export interface UseArcaSttProviderProps {
  /** Fired on EVERY switch (auto or user), in either direction — the toast/banner hook point. */
  onProviderSwitched?: (info: ProviderSwitchInfo) => void;
  /** Fired when a user-requested switch fails. Reuses the frozen v1 ErrorInfo. */
  onSwitchFailed?: (error: ErrorInfo) => void;
}

export interface UseArcaSttProviderReturn {
  /** Pipeline currently transcribing (null before capture / for local STT). */
  activeProvider: { pipelineId: string; name?: string; isFallback: boolean } | null;
  /** True when a live backend session can switch to a fallback (and isn't already on it). */
  fallbackAvailable: boolean;
  isFallbackActive: boolean;
  /**
   * True when the session is transcribing on the SDK-configured (primary)
   * pipeline; false when it's on the tenant-admin default (fallback). This is
   * the bidirectional-toggle read (TASK-586 Lane D) — `true` before any
   * capture session exists (primary is the nominal/default state).
   */
  usePipeline: boolean;
  switchStatus: 'idle' | 'switching' | 'switched' | 'failed';
  /**
   * User control flow entry point (TASK-567/568 R4). Alias of
   * {@link UseArcaSttProviderReturn.switchToDefault} — kept so every pre-586
   * caller keeps compiling and behaving identically. Idempotent — a call while
   * already on the fallback resolves without a second v2 call. Rejects with an
   * {@link ErrorInfo} (code `FALLBACK_UNAVAILABLE`) when no fallback is
   * available, or (code `SWITCH_FAILED`) when the v2 switch rejects.
   */
  switchToFallback: () => Promise<void>;
  /**
   * Switch (back) to the SDK-configured primary pipeline (TASK-586 Lane D).
   * Idempotent — a call while already on the pipeline resolves without a
   * second v2 call. Requires `enableProviderSwitch: true` on
   * `<ArcaCompatProvider>` — without it this rejects with `SWITCH_FAILED`
   * (the native streaming route has no primary-direction endpoint).
   */
  switchToPipeline: () => Promise<void>;
  /**
   * Switch to the tenant-admin default (fallback) provider (TASK-586 Lane D).
   * Same underlying call as {@link UseArcaSttProviderReturn.switchToFallback} —
   * the two names exist so a migrating app can read `switchToDefault` as the
   * bidirectional-toggle counterpart of `switchToPipeline`.
   */
  switchToDefault: () => Promise<void>;
}

function switchFailedError(err: unknown): ErrorInfo {
  return {
    code: 'SWITCH_FAILED',
    message: err instanceof Error ? err.message : String(err ?? 'STT provider switch failed'),
    severity: 'high',
    category: 'processing',
  };
}

export function useArcaSttProvider(props: UseArcaSttProviderProps = {}): UseArcaSttProviderReturn {
  const { onProviderSwitched, onSwitchFailed } = props;
  const audio = useArcaAudio();
  const { enableProviderSwitch } = useCompatFeatureFlags();
  const activePipeline = audio.activePipeline ?? null;
  // Pre-start selection (TASK-586): remembered in the store when the user picks
  // a provider BEFORE capture exists, then applied + cleared at `audio.start`.
  const pendingSttProvider = useAgenticStore((s) => s.pendingSttProvider);
  const setPendingSttProvider = useAgenticStore((s) => s.setPendingSttProvider);

  // Keep callbacks fresh without re-subscribing the switch-detect effect.
  const onProviderSwitchedRef = useRef(onProviderSwitched);
  onProviderSwitchedRef.current = onProviderSwitched;
  const onSwitchFailedRef = useRef(onSwitchFailed);
  onSwitchFailedRef.current = onSwitchFailed;

  const [switchStatus, setSwitchStatus] = useState<'idle' | 'switching' | 'switched' | 'failed'>('idle');

  // Transition detector for the fallback flip (fires onProviderSwitched for
  // BOTH directions — primary→fallback AND fallback→primary — and for both
  // auto and user switches). `prevPipelineRef` keeps the pre-flip pipeline so
  // the delivered info carries a real `fromPipeline`.
  const prevIsFallbackRef = useRef<boolean>(activePipeline?.isFallback ?? false);
  const prevPipelineRef = useRef<{ id: string; name?: string } | null>(activePipeline ? { id: activePipeline.id, name: activePipeline.name } : null);
  // True while a user-initiated switch is in flight — distinguishes the reason.
  const pendingUserSwitchRef = useRef(false);
  // Capture-relative base for `ProviderSwitchInfo.atMs` (same wall-clock base as
  // the useArcaSpeechToText metadata timeline: Date.now() at capture start).
  const captureStartMsRef = useRef<number | undefined>(undefined);

  useEffect(() => {
    if (audio.isCapturing) {
      if (captureStartMsRef.current === undefined) captureStartMsRef.current = Date.now();
    } else {
      captureStartMsRef.current = undefined;
    }
  }, [audio.isCapturing]);

  useEffect(() => {
    const isFallback = activePipeline?.isFallback ?? false;
    if (activePipeline && isFallback !== prevIsFallbackRef.current) {
      const base = captureStartMsRef.current;
      const info: ProviderSwitchInfo = {
        fromPipeline: prevPipelineRef.current ?? { id: activePipeline.id, name: activePipeline.name },
        toPipeline: { id: activePipeline.id, name: activePipeline.name },
        reason: pendingUserSwitchRef.current ? 'user' : 'auto',
        atMs: base !== undefined ? Math.max(0, Date.now() - base) : 0,
      };
      pendingUserSwitchRef.current = false;
      setSwitchStatus('switched');
      onProviderSwitchedRef.current?.(info);
    }
    prevIsFallbackRef.current = isFallback;
    prevPipelineRef.current = activePipeline ? { id: activePipeline.id, name: activePipeline.name } : null;
  }, [activePipeline]);

  const switchTo = useCallback(
    async (target: ProviderSwitchTarget): Promise<void> => {
      const current = audio.activePipeline ?? null;
      // No live backend session yet → record a PRE-START selection (TASK-586)
      // instead of rejecting. The pending pick is applied at `audio.start` by
      // whichever start hook runs first (order-independent, mirroring the
      // `languageMode` store-fallback pattern) and reflected in the read state
      // below. Once a session is live the in-place switch path (below) runs.
      if (!current) {
        setPendingSttProvider(target);
        setSwitchStatus('switched');
        return;
      }
      const isCurrentlyFallback = current.isFallback === true;
      const alreadyThere = target === 'fallback' ? isCurrentlyFallback : !isCurrentlyFallback;
      // Already on the requested side → idempotent no-op (no duplicate v2 call).
      if (alreadyThere) {
        setSwitchStatus('switched');
        return;
      }
      setSwitchStatus('switching');
      pendingUserSwitchRef.current = true;
      try {
        await audio.switchProvider(target, { useCompatEndpoint: enableProviderSwitch });
        // Success is confirmed asynchronously by the backend `provider_switched`
        // frame, which the effect above turns into onProviderSwitched + 'switched'.
      } catch (err) {
        pendingUserSwitchRef.current = false;
        setSwitchStatus('failed');
        const info = switchFailedError(err);
        onSwitchFailedRef.current?.(info);
        return Promise.reject(info);
      }
    },
    [audio, enableProviderSwitch, setPendingSttProvider],
  );

  const switchToDefault = useCallback(() => switchTo('fallback'), [switchTo]);
  const switchToPipeline = useCallback(() => switchTo('primary'), [switchTo]);

  // Before a session exists, reflect the pending pre-start selection (TASK-586)
  // so the toggle reads the right side from the first render; once live, the
  // durable `activePipeline.isFallback` is authoritative.
  const pendingIsFallback = pendingSttProvider === 'fallback';

  return {
    activeProvider: activePipeline ? { pipelineId: activePipeline.id, name: activePipeline.name, isFallback: activePipeline.isFallback } : null,
    fallbackAvailable: activePipeline != null && !activePipeline.isFallback,
    isFallbackActive: activePipeline ? activePipeline.isFallback === true : pendingIsFallback,
    usePipeline: activePipeline ? !(activePipeline.isFallback === true) : !pendingIsFallback,
    switchStatus,
    switchToFallback: switchToDefault,
    switchToPipeline,
    switchToDefault,
  };
}
