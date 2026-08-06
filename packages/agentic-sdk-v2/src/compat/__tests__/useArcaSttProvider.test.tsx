/**
 * @vitest-environment jsdom
 *
 * TASK-568 / TASK-586 Lane D — `useArcaSttProvider` (compat-native STT
 * provider-switch surface, now a BIDIRECTIONAL toggle).
 *
 * Covers:
 *  1. pre-capture: fallbackAvailable false / activeProvider null; switchToFallback
 *     rejects FALLBACK_UNAVAILABLE (frozen ErrorInfo shape); switchToPipeline
 *     rejects PIPELINE_UNAVAILABLE.
 *  2. user switch to fallback: idle → switching → switched; onProviderSwitched
 *     reason 'user'; idempotent second call (no duplicate v2 call).
 *  3. user switch BACK to primary (TASK-586): idle → switching → switched;
 *     onProviderSwitched fires for the fallback→primary direction too;
 *     idempotent second call.
 *  4. v2 rejection: switchStatus 'failed'; onSwitchFailed SWITCH_FAILED; recoverable.
 *  5. auto switch (unsolicited fallback flip): onProviderSwitched reason 'auto'.
 *  6. guarded when `enableProviderSwitch` is off: switchToPipeline still calls
 *     through (the gating lives in `StreamingSessionManager`/`useArcaAudio`),
 *     and a rejection from that layer surfaces as SWITCH_FAILED, not a crash.
 *  7. append-only export surface + return-shape lock (additive members only).
 */

import { describe, it, expect, beforeEach, afterEach, vi, expectTypeOf } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useArcaSttProvider, type UseArcaSttProviderReturn } from '../useArcaSttProvider';
import { useArcaAudio } from '../../hooks/useArcaAudio';
import { useAgenticStore } from '../../store/agenticStore';
import { useCompatFeatureFlags } from '../ArcaCompatProvider';
import * as compat from '../../compat';
import type { ErrorInfo } from '../types';

vi.mock('../../hooks/useArcaAudio', () => ({ useArcaAudio: vi.fn() }));
vi.mock('../../store/agenticStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/agenticStore')>();
  return { ...actual, useAgenticStore: vi.fn() };
});
vi.mock('../ArcaCompatProvider', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../ArcaCompatProvider')>();
  return { ...actual, useCompatFeatureFlags: vi.fn(() => ({ enableProviderSwitch: false })) };
});

type Pipeline = { id: string; name?: string; isFallback: boolean } | null;

interface AudioMock {
  isCapturing: boolean;
  activePipeline: Pipeline;
  sttConnectionState: string;
  switchProvider: ReturnType<typeof vi.fn>;
}

let audioMock: AudioMock;

function installAudio(overrides: Partial<AudioMock> = {}) {
  audioMock = {
    isCapturing: false,
    activePipeline: null,
    sttConnectionState: 'connected',
    switchProvider: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  (useArcaAudio as unknown as ReturnType<typeof vi.fn>).mockReturnValue(audioMock);
}

function installFeatureFlags(enableProviderSwitch: boolean) {
  (useCompatFeatureFlags as unknown as ReturnType<typeof vi.fn>).mockReturnValue({ enableProviderSwitch });
}

// Reactive store mock for the TASK-586 pre-start selection. `setPendingSttProvider`
// mutates the SAME object so a `rerender()` reads the updated value.
let storeState: { pendingSttProvider: 'primary' | 'fallback' | null; setPendingSttProvider: (v: 'primary' | 'fallback' | null) => void };
function installStore() {
  storeState = {
    pendingSttProvider: null,
    setPendingSttProvider: vi.fn((v: 'primary' | 'fallback' | null) => {
      storeState.pendingSttProvider = v;
    }),
  };
  (useAgenticStore as unknown as ReturnType<typeof vi.fn>).mockImplementation(
    (selector: (s: typeof storeState) => unknown) => selector(storeState),
  );
}

describe('useArcaSttProvider', () => {
  beforeEach(() => {
    installAudio();
    installFeatureFlags(false);
    installStore();
  });
  afterEach(() => vi.restoreAllMocks());

  it('before capture (TASK-586 Lane K): switchToDefault records a pending pre-start selection (resolves, no reject), flips usePipeline; switchToPipeline resets it', async () => {
    const { result, rerender } = renderHook(() => useArcaSttProvider());

    expect(result.current.activeProvider).toBeNull();
    expect(result.current.fallbackAvailable).toBe(false);
    expect(result.current.isFallbackActive).toBe(false);
    expect(result.current.usePipeline).toBe(true);
    expect(result.current.switchStatus).toBe('idle');

    // Pre-start pick of the default (fallback) provider — resolves (no reject),
    // records the pending selection, and reads as fallback BEFORE any session.
    await act(async () => {
      await result.current.switchToDefault();
    });
    expect(storeState.setPendingSttProvider).toHaveBeenLastCalledWith('fallback');
    expect(audioMock.switchProvider).not.toHaveBeenCalled();
    expect(result.current.switchStatus).toBe('switched');
    act(() => rerender());
    expect(result.current.usePipeline).toBe(false);
    expect(result.current.isFallbackActive).toBe(true);

    // Reset back to the primary pipeline pre-start.
    await act(async () => {
      await result.current.switchToPipeline();
    });
    expect(storeState.setPendingSttProvider).toHaveBeenLastCalledWith('primary');
    expect(audioMock.switchProvider).not.toHaveBeenCalled();
    act(() => rerender());
    expect(result.current.usePipeline).toBe(true);
    expect(result.current.isFallbackActive).toBe(false);
  });

  it('user switch to fallback: idle → switching → switched, onProviderSwitched reason "user", idempotent second call', async () => {
    const onProviderSwitched = vi.fn();
    installAudio({ isCapturing: true, activePipeline: { id: 'primary', name: 'Primary', isFallback: false } });

    const { result, rerender } = renderHook(() => useArcaSttProvider({ onProviderSwitched }));
    expect(result.current.fallbackAvailable).toBe(true);
    expect(result.current.usePipeline).toBe(true);

    await act(async () => {
      await result.current.switchToFallback();
    });
    // Backend confirmation not observed yet — still 'switching'.
    expect(result.current.switchStatus).toBe('switching');
    expect(audioMock.switchProvider).toHaveBeenCalledTimes(1);
    expect(audioMock.switchProvider).toHaveBeenCalledWith('fallback', { useCompatEndpoint: false });

    // Backend `provider_switched` frame lands: the store flips activePipeline.
    audioMock.activePipeline = { id: 'fallback', name: 'Fallback', isFallback: true };
    act(() => rerender());

    expect(result.current.switchStatus).toBe('switched');
    expect(result.current.isFallbackActive).toBe(true);
    expect(result.current.usePipeline).toBe(false);
    expect(result.current.activeProvider).toEqual({ pipelineId: 'fallback', name: 'Fallback', isFallback: true });
    expect(result.current.fallbackAvailable).toBe(false);
    expect(onProviderSwitched).toHaveBeenCalledTimes(1);
    const info = onProviderSwitched.mock.calls[0][0];
    expect(info).toMatchObject({
      fromPipeline: { id: 'primary' },
      toPipeline: { id: 'fallback' },
      reason: 'user',
    });
    expect(typeof info.atMs).toBe('number');
    expect(info.atMs).toBeGreaterThanOrEqual(0);

    // Idempotent: already on the fallback → no second v2 call.
    await act(async () => {
      await result.current.switchToFallback();
    });
    expect(audioMock.switchProvider).toHaveBeenCalledTimes(1);
  });

  it('user switch BACK to primary (TASK-586): idle → switching → switched, onProviderSwitched fires, idempotent second call', async () => {
    const onProviderSwitched = vi.fn();
    installAudio({ isCapturing: true, activePipeline: { id: 'fallback', name: 'Fallback', isFallback: true } });
    installFeatureFlags(true);

    const { result, rerender } = renderHook(() => useArcaSttProvider({ onProviderSwitched }));
    expect(result.current.usePipeline).toBe(false);
    expect(result.current.isFallbackActive).toBe(true);

    await act(async () => {
      await result.current.switchToPipeline();
    });
    expect(result.current.switchStatus).toBe('switching');
    expect(audioMock.switchProvider).toHaveBeenCalledTimes(1);
    expect(audioMock.switchProvider).toHaveBeenCalledWith('primary', { useCompatEndpoint: true });

    // Backend `provider_switched` frame lands, un-latched back to primary.
    audioMock.activePipeline = { id: 'primary', name: 'Primary', isFallback: false };
    act(() => rerender());

    expect(result.current.switchStatus).toBe('switched');
    expect(result.current.isFallbackActive).toBe(false);
    expect(result.current.usePipeline).toBe(true);
    expect(result.current.fallbackAvailable).toBe(true);
    expect(onProviderSwitched).toHaveBeenCalledTimes(1);
    expect(onProviderSwitched.mock.calls[0][0]).toMatchObject({
      fromPipeline: { id: 'fallback' },
      toPipeline: { id: 'primary' },
      reason: 'user',
    });

    // Idempotent: already on the primary pipeline → no second v2 call.
    await act(async () => {
      await result.current.switchToPipeline();
    });
    expect(audioMock.switchProvider).toHaveBeenCalledTimes(1);
  });

  it('v2 rejection: switchStatus "failed", onSwitchFailed SWITCH_FAILED, recoverable (retry allowed)', async () => {
    const onSwitchFailed = vi.fn();
    installAudio({ isCapturing: true, activePipeline: { id: 'primary', isFallback: false } });
    audioMock.switchProvider.mockRejectedValueOnce(new Error('boom'));

    const { result } = renderHook(() => useArcaSttProvider({ onSwitchFailed }));

    let rejected: ErrorInfo | undefined;
    await act(async () => {
      await result.current.switchToFallback().catch((e: ErrorInfo) => {
        rejected = e;
      });
    });
    expect(rejected).toMatchObject({ code: 'SWITCH_FAILED', category: 'processing', message: 'boom' });
    expect(result.current.switchStatus).toBe('failed');
    expect(onSwitchFailed).toHaveBeenCalledWith(expect.objectContaining({ code: 'SWITCH_FAILED' }));

    // Retry allowed — the next call re-enters 'switching' (state recoverable).
    await act(async () => {
      await result.current.switchToFallback();
    });
    expect(result.current.switchStatus).toBe('switching');
  });

  it('auto switch (unsolicited fallback flip): onProviderSwitched reason "auto"', () => {
    const onProviderSwitched = vi.fn();
    installAudio({ isCapturing: true, activePipeline: { id: 'primary', isFallback: false } });

    const { rerender } = renderHook(() => useArcaSttProvider({ onProviderSwitched }));

    // No switchToFallback() call — the backend auto-switched on an outage.
    audioMock.activePipeline = { id: 'fallback', isFallback: true };
    act(() => rerender());

    expect(onProviderSwitched).toHaveBeenCalledTimes(1);
    expect(onProviderSwitched.mock.calls[0][0]).toMatchObject({ reason: 'auto', toPipeline: { id: 'fallback' } });
    expect(audioMock.switchProvider).not.toHaveBeenCalled();
  });

  it('guarded when enableProviderSwitch is off: switchToPipeline still calls through useArcaAudio, and a downstream rejection surfaces as SWITCH_FAILED (not a crash)', async () => {
    const onSwitchFailed = vi.fn();
    installAudio({ isCapturing: true, activePipeline: { id: 'fallback', isFallback: true } });
    installFeatureFlags(false);
    // Without the compat endpoint enabled, the native session manager has no
    // primary-direction route — useArcaAudio/StreamingSessionManager reject.
    audioMock.switchProvider.mockRejectedValueOnce(
      Object.assign(new Error('Switching back to the primary pipeline requires the compat provider-switch endpoint'), { code: 'NOT_SUPPORTED' }),
    );

    const { result } = renderHook(() => useArcaSttProvider({ onSwitchFailed }));

    let rejected: ErrorInfo | undefined;
    await act(async () => {
      await result.current.switchToPipeline().catch((e: ErrorInfo) => {
        rejected = e;
      });
    });

    expect(audioMock.switchProvider).toHaveBeenCalledWith('primary', { useCompatEndpoint: false });
    expect(rejected).toMatchObject({ code: 'SWITCH_FAILED', category: 'processing' });
    expect(result.current.switchStatus).toBe('failed');
    expect(onSwitchFailed).toHaveBeenCalledWith(expect.objectContaining({ code: 'SWITCH_FAILED' }));
  });

  it('export surface is append-only and the hook return shape is locked', () => {
    // The TASK-561/564 frozen runtime members are all still present …
    for (const name of [
      'ArcaCompatProvider',
      'mapV1ConfigToAgenticConfig',
      'useArcaSessionManager',
      'mapV2StatusToV1',
      'useAudioCapture',
      'useArcaSpeechToText',
      'useSMR',
    ]) {
      expect(typeof (compat as Record<string, unknown>)[name]).toBe('function');
    }
    // … plus the new compat-native addition.
    expect(typeof compat.useArcaSttProvider).toBe('function');

    // Every TASK-568 member is still present with its original signature —
    // TASK-586 only ADDS members (usePipeline/switchToPipeline/switchToDefault).
    expectTypeOf<UseArcaSttProviderReturn['fallbackAvailable']>().toEqualTypeOf<boolean>();
    expectTypeOf<UseArcaSttProviderReturn['isFallbackActive']>().toEqualTypeOf<boolean>();
    expectTypeOf<UseArcaSttProviderReturn['switchStatus']>().toEqualTypeOf<'idle' | 'switching' | 'switched' | 'failed'>();
    expectTypeOf<UseArcaSttProviderReturn['switchToFallback']>().returns.resolves.toBeVoid();
    expectTypeOf<UseArcaSttProviderReturn['activeProvider']>().toEqualTypeOf<{
      pipelineId: string;
      name?: string;
      isFallback: boolean;
    } | null>();

    // New TASK-586 members.
    expectTypeOf<UseArcaSttProviderReturn['usePipeline']>().toEqualTypeOf<boolean>();
    expectTypeOf<UseArcaSttProviderReturn['switchToPipeline']>().returns.resolves.toBeVoid();
    expectTypeOf<UseArcaSttProviderReturn['switchToDefault']>().returns.resolves.toBeVoid();
  });
});

/**
 * TASK-614 D-2/D-5/D-7 — "is there a live session?" is answered by CAPTURE.
 *
 * `activePipeline` is request-derived: it is `null` for the whole session
 * whenever the app started capture without an explicit `pipelineId` (the
 * gateway then resolves one server-side). Keying the pre-start branch off it
 * meant a MID-SESSION switch was silently recorded as a pre-start preference
 * and reported as `switched` — no HTTP call, no WS frame, no error. The field
 * report: "I switched the STT engine to Off and nothing reached the backend."
 *
 * The distinction the hook actually needs is "has capture started", which
 * `audio.isCapturing` answers directly.
 */
describe('useArcaSttProvider — live switch is gated on capture, not on activePipeline (TASK-614)', () => {
  beforeEach(() => {
    installAudio();
    installFeatureFlags(false);
    installStore();
  });
  afterEach(() => vi.restoreAllMocks());

  it('performs the switch mid-session even when the active pipeline is unknown', async () => {
    installAudio({ isCapturing: true, activePipeline: null });
    const { result } = renderHook(() => useArcaSttProvider());

    await act(async () => {
      await result.current.switchToDefault();
    });

    expect(audioMock.switchProvider).toHaveBeenCalledTimes(1);
    expect(audioMock.switchProvider).toHaveBeenCalledWith('fallback', { useCompatEndpoint: false });
    // …and it must NOT be mistaken for a pre-start pick.
    expect(storeState.setPendingSttProvider).not.toHaveBeenCalled();
    // Still awaiting the backend's provider_switched frame.
    expect(result.current.switchStatus).toBe('switching');
  });

  it('performs the switch back to primary mid-session with an unknown active pipeline', async () => {
    installAudio({ isCapturing: true, activePipeline: null });
    installFeatureFlags(true);
    const { result } = renderHook(() => useArcaSttProvider());

    await act(async () => {
      await result.current.switchToPipeline();
    });

    expect(audioMock.switchProvider).toHaveBeenCalledWith('primary', { useCompatEndpoint: true });
    expect(storeState.setPendingSttProvider).not.toHaveBeenCalled();
  });

  it('rejects with SWITCH_UNSUPPORTED — never "switched" — when capture has no backend streaming session', async () => {
    // Capture is running on LOCAL (browser) STT, or the transport never came
    // up: there is genuinely nothing to switch. Resolving as `switched` here is
    // the failure mode this ticket exists to remove.
    const onSwitchFailed = vi.fn();
    installAudio({ isCapturing: true, activePipeline: null });
    audioMock.switchProvider.mockRejectedValueOnce(new Error('No active streaming session to switch to fallback'));

    const { result } = renderHook(() => useArcaSttProvider({ onSwitchFailed }));

    let rejected: ErrorInfo | undefined;
    await act(async () => {
      await result.current.switchToDefault().catch((e: ErrorInfo) => {
        rejected = e;
      });
    });

    expect(rejected).toMatchObject({ code: 'SWITCH_UNSUPPORTED', category: 'configuration' });
    expect(result.current.switchStatus).toBe('failed');
    expect(onSwitchFailed).toHaveBeenCalledWith(expect.objectContaining({ code: 'SWITCH_UNSUPPORTED' }));
  });

  it('still records a PRE-START preference before capture begins (TASK-586 behaviour preserved)', async () => {
    installAudio({ isCapturing: false, activePipeline: null });
    const { result } = renderHook(() => useArcaSttProvider());

    await act(async () => {
      await result.current.switchToDefault();
    });

    expect(storeState.setPendingSttProvider).toHaveBeenLastCalledWith('fallback');
    expect(audioMock.switchProvider).not.toHaveBeenCalled();
    expect(result.current.switchStatus).toBe('switched');
  });
});
