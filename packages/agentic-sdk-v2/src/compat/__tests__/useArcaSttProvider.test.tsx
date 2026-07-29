/**
 * @vitest-environment jsdom
 *
 * TASK-568 — `useArcaSttProvider` (compat-native STT provider-switch surface).
 *
 * Covers the §5 TDD plan for the new hook:
 *  1. pre-capture: fallbackAvailable false / activeProvider null; switchToFallback
 *     rejects FALLBACK_UNAVAILABLE (frozen ErrorInfo shape).
 *  2. user switch: idle → switching → switched; onProviderSwitched reason 'user';
 *     idempotent second call (no duplicate v2 call).
 *  3. v2 rejection: switchStatus 'failed'; onSwitchFailed SWITCH_FAILED; recoverable.
 *  4. auto switch (unsolicited fallback flip): onProviderSwitched reason 'auto'.
 *  5. append-only export surface + return-shape lock.
 */

import { describe, it, expect, beforeEach, afterEach, vi, expectTypeOf } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useArcaSttProvider, type UseArcaSttProviderReturn } from '../useArcaSttProvider';
import { useArcaAudio } from '../../hooks/useArcaAudio';
import * as compat from '../../compat';
import type { ErrorInfo } from '../types';

vi.mock('../../hooks/useArcaAudio', () => ({ useArcaAudio: vi.fn() }));

type Pipeline = { id: string; name?: string; isFallback: boolean } | null;

interface AudioMock {
  isCapturing: boolean;
  activePipeline: Pipeline;
  sttConnectionState: string;
  switchToFallback: ReturnType<typeof vi.fn>;
}

let audioMock: AudioMock;

function installAudio(overrides: Partial<AudioMock> = {}) {
  audioMock = {
    isCapturing: false,
    activePipeline: null,
    sttConnectionState: 'connected',
    switchToFallback: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  (useArcaAudio as unknown as ReturnType<typeof vi.fn>).mockReturnValue(audioMock);
}

describe('useArcaSttProvider', () => {
  beforeEach(() => installAudio());
  afterEach(() => vi.restoreAllMocks());

  it('before capture: no active provider, no fallback, switchToFallback rejects FALLBACK_UNAVAILABLE', async () => {
    const { result } = renderHook(() => useArcaSttProvider());

    expect(result.current.activeProvider).toBeNull();
    expect(result.current.fallbackAvailable).toBe(false);
    expect(result.current.isFallbackActive).toBe(false);
    expect(result.current.switchStatus).toBe('idle');

    let rejected: ErrorInfo | undefined;
    await act(async () => {
      await result.current.switchToFallback().catch((e: ErrorInfo) => {
        rejected = e;
      });
    });
    expect(rejected).toMatchObject({ code: 'FALLBACK_UNAVAILABLE', category: 'processing' });
    expect(audioMock.switchToFallback).not.toHaveBeenCalled();
  });

  it('user switch: idle → switching → switched, onProviderSwitched reason "user", idempotent second call', async () => {
    const onProviderSwitched = vi.fn();
    installAudio({ isCapturing: true, activePipeline: { id: 'primary', name: 'Primary', isFallback: false } });

    const { result, rerender } = renderHook(() => useArcaSttProvider({ onProviderSwitched }));
    expect(result.current.fallbackAvailable).toBe(true);

    await act(async () => {
      await result.current.switchToFallback();
    });
    // Backend confirmation not observed yet — still 'switching'.
    expect(result.current.switchStatus).toBe('switching');
    expect(audioMock.switchToFallback).toHaveBeenCalledTimes(1);

    // Backend `provider_switched` frame lands: the store flips activePipeline.
    audioMock.activePipeline = { id: 'fallback', name: 'Fallback', isFallback: true };
    act(() => rerender());

    expect(result.current.switchStatus).toBe('switched');
    expect(result.current.isFallbackActive).toBe(true);
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
    expect(audioMock.switchToFallback).toHaveBeenCalledTimes(1);
  });

  it('v2 rejection: switchStatus "failed", onSwitchFailed SWITCH_FAILED, recoverable (retry allowed)', async () => {
    const onSwitchFailed = vi.fn();
    installAudio({ isCapturing: true, activePipeline: { id: 'primary', isFallback: false } });
    audioMock.switchToFallback.mockRejectedValueOnce(new Error('boom'));

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
    expect(audioMock.switchToFallback).not.toHaveBeenCalled();
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

    expectTypeOf<UseArcaSttProviderReturn['fallbackAvailable']>().toEqualTypeOf<boolean>();
    expectTypeOf<UseArcaSttProviderReturn['isFallbackActive']>().toEqualTypeOf<boolean>();
    expectTypeOf<UseArcaSttProviderReturn['switchStatus']>().toEqualTypeOf<'idle' | 'switching' | 'switched' | 'failed'>();
    expectTypeOf<UseArcaSttProviderReturn['switchToFallback']>().returns.resolves.toBeVoid();
    expectTypeOf<UseArcaSttProviderReturn['activeProvider']>().toEqualTypeOf<{
      pipelineId: string;
      name?: string;
      isFallback: boolean;
    } | null>();
  });
});
