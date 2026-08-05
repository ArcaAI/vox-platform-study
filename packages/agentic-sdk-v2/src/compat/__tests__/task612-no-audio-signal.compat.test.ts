/**
 * useArcaSpeechToText — `no_audio_signal` surfacing (TASK-612 Lane D, AC-4).
 *
 * The silent-uplink watchdog publishes `audioSignalState: 'ok' | 'silent'` on
 * the store. The compat hook mirrors it onto the frozen-but-optional v1
 * `onStatus` prop — the same additive pattern TASK-568 used for
 * `reconnecting`/`reconnected` — so a v1 app learns "the socket is open but
 * the audio being sent is silence" without reading v2 state.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook } from '@testing-library/react';

// Selector-aware store double: the compat hook reads several selectors
// (`transcriptSegments`, `pendingSttProvider`, `audioSignalState`, …), so the
// mock must actually APPLY the selector instead of returning the state bag.
let mockState: Record<string, any>;
vi.mock('../../store/agenticStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/agenticStore')>();
  return {
    ...actual,
    useAgenticStore: vi.fn((selector?: (s: Record<string, any>) => unknown) => (selector ? selector(mockState) : mockState)),
  };
});

// The compat hook also drives useArcaAudio — stub it to an inert audio object
// so only the store-driven status surfacing is under test.
const audioMock = {
  isCapturing: false,
  level: 0,
  sourceLevels: [],
  sttConnectionState: 'connected',
  activePipeline: null,
  start: vi.fn(async () => undefined),
  stop: vi.fn(async () => undefined),
};
vi.mock('../../hooks/useArcaAudio', () => ({ useArcaAudio: vi.fn(() => audioMock) }));

import { useArcaSpeechToText } from '../useArcaSpeechToText';

function baseState(overrides: Record<string, any> = {}) {
  return {
    transcriptSegments: [],
    currentTranscript: '',
    pendingSttProvider: null,
    setPendingSttProvider: vi.fn(),
    setAudioLanguage: vi.fn(),
    setSttLanguageMode: vi.fn(),
    apiClient: null,
    logger: null,
    audioSignalState: 'ok',
    ...overrides,
  };
}

type OnStatus = (status: string, data?: unknown) => void;

function renderCompat(onStatus: OnStatus) {
  return renderHook(() =>
    useArcaSpeechToText({
      sessionId: 's-1',
      language: 'en',
      onTranscript: vi.fn(),
      onStatus,
    }),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockState = baseState();
});

describe('useArcaSpeechToText — no_audio_signal status (TASK-612 Lane D)', () => {
  it('emits no_audio_signal once on ok→silent and audio_signal_restored once on silent→ok', () => {
    const onStatus = vi.fn<OnStatus>();
    const { rerender } = renderCompat(onStatus);

    expect(onStatus).not.toHaveBeenCalledWith('no_audio_signal');

    mockState = baseState({ audioSignalState: 'silent' });
    rerender();
    expect(onStatus.mock.calls.filter((c) => c[0] === 'no_audio_signal')).toHaveLength(1);

    // Re-render with the state unchanged — no duplicate emission.
    rerender();
    expect(onStatus.mock.calls.filter((c) => c[0] === 'no_audio_signal')).toHaveLength(1);

    mockState = baseState({ audioSignalState: 'ok' });
    rerender();
    expect(onStatus.mock.calls.filter((c) => c[0] === 'audio_signal_restored')).toHaveLength(1);
  });

  it('emits nothing on mount when the signal is already ok, and never throws without onStatus', () => {
    const onStatus = vi.fn<OnStatus>();
    renderCompat(onStatus);
    expect(onStatus).not.toHaveBeenCalledWith('no_audio_signal');
    expect(onStatus).not.toHaveBeenCalledWith('audio_signal_restored');

    // No onStatus prop at all — transitions must be a safe no-op.
    mockState = baseState({ audioSignalState: 'silent' });
    expect(() =>
      renderHook(() =>
        useArcaSpeechToText({
          sessionId: 's-2',
          language: 'en',
          onTranscript: vi.fn(),
        }),
      ),
    ).not.toThrow();
  });
});
