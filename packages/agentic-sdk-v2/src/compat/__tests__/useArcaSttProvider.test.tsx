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
import { useCompatFeatureFlags } from '../ArcaCompatProvider';
import * as compat from '../../compat';
import type { ErrorInfo } from '../types';

vi.mock('../../hooks/useArcaAudio', () => ({ useArcaAudio: vi.fn() }));
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

describe('useArcaSttProvider', () => {
  beforeEach(() => {
    installAudio();
    installFeatureFlags(false);
  });
  afterEach(() => vi.restoreAllMocks());

  it('before capture: no active provider, no fallback, switchToFallback rejects FALLBACK_UNAVAILABLE, switchToPipeline rejects PIPELINE_UNAVAILABLE', async () => {
    const { result } = renderHook(() => useArcaSttProvider());

    expect(result.current.activeProvider).toBeNull();
    expect(result.current.fallbackAvailable).toBe(false);
    expect(result.current.isFallbackActive).toBe(false);
    expect(result.current.usePipeline).toBe(true);
    expect(result.current.switchStatus).toBe('idle');

    let rejected: ErrorInfo | undefined;
    await act(async () => {
      await result.current.switchToFallback().catch((e: ErrorInfo) => {
        rejected = e;
      });
    });
    expect(rejected).toMatchObject({ code: 'FALLBACK_UNAVAILABLE', category: 'processing' });
    expect(audioMock.switchProvider).not.toHaveBeenCalled();

    let rejectedPipeline: ErrorInfo | undefined;
    await act(async () => {
      await result.current.switchToPipeline().catch((e: ErrorInfo) => {
        rejectedPipeline = e;
      });
    });
    expect(rejectedPipeline).toMatchObject({ code: 'PIPELINE_UNAVAILABLE', category: 'processing' });
    expect(audioMock.switchProvider).not.toHaveBeenCalled();
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
