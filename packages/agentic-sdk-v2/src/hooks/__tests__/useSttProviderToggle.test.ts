/**
 * useSttProviderToggle — native 2-way STT provider toggle (TASK-586 Lane H).
 *
 * Locks the native (non-compat) end-user affordance:
 *   - `switchToPipeline()` → `audio.switchProvider('primary')` (native route);
 *   - `switchToDefault()`  → `audio.switchProvider('fallback')` (native route);
 *   - `activeProvider` / `usePipeline` / `isFallbackActive` are derived from
 *     `audio.activePipeline`;
 *   - both directions are idempotent (no duplicate v2 call when already there);
 *   - both reject cleanly when there is no live streaming session.
 *
 * It is a THIN adapter over the public `useArcaAudio()` surface, so the test
 * mocks that surface directly and asserts the delegation.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

let mockAudio: Record<string, any>;
vi.mock('../useArcaAudio', () => ({
  useArcaAudio: vi.fn(() => mockAudio),
}));

import { useSttProviderToggle } from '../useSttProviderToggle';

function setupAudio(overrides: Record<string, any> = {}) {
  mockAudio = {
    isCapturing: true,
    activePipeline: { id: 'primary', name: 'Primary', isFallback: false },
    switchProvider: vi.fn().mockResolvedValue(undefined),
    switchToFallback: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
  return mockAudio;
}

beforeEach(() => {
  vi.clearAllMocks();
  setupAudio();
});

describe('useSttProviderToggle — derived reads', () => {
  it('derives activeProvider / usePipeline from a primary active pipeline', () => {
    setupAudio({ activePipeline: { id: 'primary', name: 'Primary', isFallback: false } });
    const { result } = renderHook(() => useSttProviderToggle());

    expect(result.current.activeProvider).toEqual({ pipelineId: 'primary', name: 'Primary', isFallback: false });
    expect(result.current.usePipeline).toBe(true);
    expect(result.current.isFallbackActive).toBe(false);
  });

  it('derives usePipeline=false / isFallbackActive=true on a fallback active pipeline', () => {
    setupAudio({ activePipeline: { id: 'sarvam', name: 'Sarvam', isFallback: true } });
    const { result } = renderHook(() => useSttProviderToggle());

    expect(result.current.usePipeline).toBe(false);
    expect(result.current.isFallbackActive).toBe(true);
  });

  it('reports a null provider and usePipeline=true (nominal) with no active pipeline', () => {
    setupAudio({ activePipeline: null });
    const { result } = renderHook(() => useSttProviderToggle());

    expect(result.current.activeProvider).toBeNull();
    expect(result.current.usePipeline).toBe(true);
    expect(result.current.isFallbackActive).toBe(false);
  });
});

describe('useSttProviderToggle — switching (both directions)', () => {
  it("switchToDefault() delegates to audio.switchProvider('fallback')", async () => {
    setupAudio({ activePipeline: { id: 'primary', name: 'Primary', isFallback: false } });
    const { result } = renderHook(() => useSttProviderToggle());

    await act(async () => {
      await result.current.switchToDefault();
    });

    expect(mockAudio.switchProvider).toHaveBeenCalledWith('fallback');
    expect(result.current.switchStatus).toBe('switching');
  });

  it("switchToPipeline() delegates to audio.switchProvider('primary')", async () => {
    setupAudio({ activePipeline: { id: 'sarvam', name: 'Sarvam', isFallback: true } });
    const { result } = renderHook(() => useSttProviderToggle());

    await act(async () => {
      await result.current.switchToPipeline();
    });

    expect(mockAudio.switchProvider).toHaveBeenCalledWith('primary');
  });

  it('is idempotent — switchToDefault() while already on fallback makes no v2 call', async () => {
    setupAudio({ activePipeline: { id: 'sarvam', name: 'Sarvam', isFallback: true } });
    const { result } = renderHook(() => useSttProviderToggle());

    await act(async () => {
      await result.current.switchToDefault();
    });

    expect(mockAudio.switchProvider).not.toHaveBeenCalled();
    expect(result.current.switchStatus).toBe('switched');
  });

  it('is idempotent — switchToPipeline() while already on primary makes no v2 call', async () => {
    setupAudio({ activePipeline: { id: 'primary', name: 'Primary', isFallback: false } });
    const { result } = renderHook(() => useSttProviderToggle());

    await act(async () => {
      await result.current.switchToPipeline();
    });

    expect(mockAudio.switchProvider).not.toHaveBeenCalled();
    expect(result.current.switchStatus).toBe('switched');
  });

  // TASK-614 D-3: this used to assert that a null `activePipeline` blocked the
  // switch. That premise was wrong — `activePipeline` is request-derived and is
  // null for the WHOLE session whenever capture started without an explicit
  // `pipelineId`, so the guard fired mid-session on a perfectly live session.
  // "Is there a session to switch?" is `isCapturing`; the pipeline identity is
  // a separate question the client may legitimately not know yet.
  it('switches mid-session even when the active pipeline is unknown', async () => {
    setupAudio({ isCapturing: true, activePipeline: null });
    const { result } = renderHook(() => useSttProviderToggle());

    await act(async () => {
      await result.current.switchToDefault();
    });

    expect(mockAudio.switchProvider).toHaveBeenCalledWith('fallback');
    expect(result.current.switchStatus).toBe('switching');
  });

  it('rejects with SWITCH_UNSUPPORTED when capture has not started', async () => {
    setupAudio({ isCapturing: false, activePipeline: null });
    const { result } = renderHook(() => useSttProviderToggle());

    let caught: any;
    await act(async () => {
      await result.current.switchToDefault().catch((err: unknown) => {
        caught = err;
      });
    });

    expect(caught?.code).toBe('SWITCH_UNSUPPORTED');
    expect(mockAudio.switchProvider).not.toHaveBeenCalled();
  });

  it('marks switchStatus=failed and rethrows when the v2 switch rejects', async () => {
    const boom = new Error('server exploded');
    setupAudio({
      activePipeline: { id: 'primary', name: 'Primary', isFallback: false },
      switchProvider: vi.fn().mockRejectedValue(boom),
    });
    const { result } = renderHook(() => useSttProviderToggle());

    let caught: unknown;
    await act(async () => {
      try {
        await result.current.switchToDefault();
      } catch (err) {
        caught = err;
      }
    });

    expect(caught).toBe(boom);
    expect(result.current.switchStatus).toBe('failed');
  });
});
