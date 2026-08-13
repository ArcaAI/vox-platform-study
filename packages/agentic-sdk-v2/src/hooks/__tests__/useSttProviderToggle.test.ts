/**
 * useSttProviderToggle — native 2-way STT provider toggle.
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
import { renderHook, act, waitFor } from '@testing-library/react';

let mockAudio: Record<string, any>;
vi.mock('../useArcaAudio', () => ({
  useArcaAudio: vi.fn(() => mockAudio),
}));

// The toggle now also READS the tenant's configured fallback so a UI
// can name the target and disable the control when none is set. That goes
// through the provider store, which is mocked here for the same reason
// `useArcaAudio` is: this hook is an adapter, and its dependencies are contracts.
const mockApiClient = { get: vi.fn() };
vi.mock('../../store', () => ({
  useAgenticStore: () => ({ apiClient: mockApiClient, logger: undefined }),
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
  mockApiClient.get.mockResolvedValue({ configured: true, pipelineId: 'sarvam-fallback', pipelineName: 'Sarvam (fallback)' });
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

  // This used to assert that a null `activePipeline` blocked the
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

// ── additions ──────────────────────────────────────────────────────

describe('useSttProviderToggle — fallback discovery', () => {
  it('names the tenant’s configured fallback so the control is not labelled blindly', async () => {
    const { result } = renderHook(() => useSttProviderToggle());

    await waitFor(() => expect(result.current.fallback).not.toBeNull());
    expect(mockApiClient.get).toHaveBeenCalledWith('/audio/transcription-jobs/fallback');
    expect(result.current.fallback).toEqual({ configured: true, pipelineId: 'sarvam-fallback', pipelineName: 'Sarvam (fallback)' });
  });

  it('allows switching to default only when a fallback is actually configured', async () => {
    const { result } = renderHook(() => useSttProviderToggle());
    await waitFor(() => expect(result.current.canSwitchToDefault).toBe(true));
  });

  it('blocks the switch up front when no fallback is configured', async () => {
    // The point of the read: without it the user finds out through a 409 in the
    // middle of a consultation.
    mockApiClient.get.mockResolvedValue({ configured: false, pipelineId: null, pipelineName: null });
    const { result } = renderHook(() => useSttProviderToggle());

    await waitFor(() => expect(result.current.fallback?.configured).toBe(false));
    expect(result.current.canSwitchToDefault).toBe(false);
  });

  it('blocks the switch while there is no live session to switch', async () => {
    setupAudio({ activePipeline: null });
    const { result } = renderHook(() => useSttProviderToggle());
    await waitFor(() => expect(result.current.fallback?.configured).toBe(true));
    expect(result.current.canSwitchToDefault).toBe(false);
  });

  it('blocks a redundant switch while already on the fallback', async () => {
    setupAudio({ activePipeline: { id: 'sarvam-fallback', name: 'Sarvam', isFallback: true } });
    const { result } = renderHook(() => useSttProviderToggle());
    await waitFor(() => expect(result.current.fallback?.configured).toBe(true));
    expect(result.current.canSwitchToDefault).toBe(false);
  });

  it('degrades to unknown (never throws) when the lookup fails', async () => {
    mockApiClient.get.mockRejectedValue(new Error('offline'));
    const { result } = renderHook(() => useSttProviderToggle());

    await waitFor(() => expect(mockApiClient.get).toHaveBeenCalled());
    expect(result.current.fallback).toBeNull();
    // Unknown must not disable the control — the switch itself remains the
    // authority, and a lookup blip should not remove the user's fallback.
    expect(result.current.canSwitchToDefault).toBe(true);
  });
});

describe('useSttProviderToggle — error surface', () => {
  it('exposes the failure instead of forcing every caller to try/catch', async () => {
    const boom = new Error('no fallback configured for this tenant');
    setupAudio({ activePipeline: { id: 'primary', name: 'Primary', isFallback: false }, switchProvider: vi.fn().mockRejectedValue(boom) });
    const { result } = renderHook(() => useSttProviderToggle());

    await act(async () => {
      await result.current.switchToDefault().catch(() => {});
    });

    expect(result.current.switchStatus).toBe('failed');
    expect(result.current.switchError).toBe(boom);
  });

  it('clears the previous error when a new switch starts', async () => {
    const failing = vi.fn().mockRejectedValueOnce(new Error('first failed')).mockResolvedValueOnce(undefined);
    setupAudio({ activePipeline: { id: 'primary', name: 'Primary', isFallback: false }, switchProvider: failing });
    const { result } = renderHook(() => useSttProviderToggle());

    await act(async () => {
      await result.current.switchToDefault().catch(() => {});
    });
    expect(result.current.switchError).not.toBeNull();

    await act(async () => {
      await result.current.switchToDefault();
    });
    expect(result.current.switchError).toBeNull();
    expect(result.current.switchStatus).toBe('switching');
  });

  it('resetSwitchStatus() returns the control to idle so a banner can be dismissed', async () => {
    setupAudio({ activePipeline: { id: 'primary', name: 'Primary', isFallback: false }, switchProvider: vi.fn().mockRejectedValue(new Error('x')) });
    const { result } = renderHook(() => useSttProviderToggle());

    await act(async () => {
      await result.current.switchToDefault().catch(() => {});
    });
    act(() => result.current.resetSwitchStatus());

    expect(result.current.switchStatus).toBe('idle');
    expect(result.current.switchError).toBeNull();
  });
});
