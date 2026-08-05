/**
 * useArcaSpeechToText — empty-final hygiene + interim-ref reset (TASK-612
 * Lane F, findings I-1/I-2, OD-3a).
 *
 * Belt-and-braces at the compat layer: even though `useArcaAudio` now
 * suppresses whitespace-only finals before they ever reach the store (see
 * `../../hooks/__tests__/task612-empty-final-hygiene.test.ts`), the
 * final-diff loop here ALSO skips any segment whose text is empty/whitespace,
 * so a stray empty segment from any other producer can never render
 * `onTranscript("… : ", true, …)`. The diff cursor still advances to
 * `segments.length` after the loop, so a skipped segment is never re-visited.
 *
 * Also locks the I-2 fix: `stopTranscription` now resets `lastInterimRef`
 * alongside the existing timeline/anchor resets, so an identical first
 * interim in the NEXT session is delivered again instead of being silently
 * swallowed by the stale ref left over from the previous session.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';

// Selector-aware store double: the compat hook reads several selectors
// (`transcriptSegments`, `currentTranscript`, `pendingSttProvider`, …), so the
// mock must actually APPLY the selector instead of returning the state bag.
// Copied from task612-no-audio-signal.compat.test.ts.
let mockState: Record<string, any>;
vi.mock('../../store/agenticStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/agenticStore')>();
  return {
    ...actual,
    useAgenticStore: vi.fn((selector?: (s: Record<string, any>) => unknown) => (selector ? selector(mockState) : mockState)),
  };
});

// The compat hook also drives useArcaAudio — stub it to an inert, MUTABLE
// audio object. `isCapturing` is toggled directly by the interim-reset test
// to satisfy stopTranscription's idempotency guard without a real session.
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

beforeEach(() => {
  vi.clearAllMocks();
  mockState = baseState();
  audioMock.isCapturing = false;
});

describe('useArcaSpeechToText — empty-final segment skip (TASK-612 Lane F, OD-3a)', () => {
  it('(1) a whitespace-only segment never fires onTranscript; a later real final still fires exactly once', () => {
    const onTranscript = vi.fn();
    mockState = baseState({
      transcriptSegments: [{ isFinal: true, text: '   ', startTime: 0, endTime: 0 }],
    });
    const { rerender } = renderHook(() => useArcaSpeechToText({ sessionId: 's-1', language: 'en', onTranscript }));

    expect(onTranscript).not.toHaveBeenCalled();

    // A real final is APPENDED (the whitespace segment stays at index 0) — the
    // cursor must have advanced past it, not re-visit it.
    mockState = baseState({
      transcriptSegments: [
        { isFinal: true, text: '   ', startTime: 0, endTime: 0 },
        { isFinal: true, text: 'hello', startTime: 1, endTime: 2 },
      ],
    });
    rerender();

    expect(onTranscript).toHaveBeenCalledTimes(1);
    const [text, isFinal] = onTranscript.mock.calls[0]!;
    expect(text).toContain('hello');
    expect(isFinal).toBe(true);
  });
});

describe('useArcaSpeechToText — lastInterimRef reset on stop (TASK-612 Lane F, I-2)', () => {
  it('(2) the same interim text fires again in a new session after stopTranscription resets lastInterimRef', async () => {
    const onTranscript = vi.fn();
    mockState = baseState({ currentTranscript: 'hello' });
    const { result, rerender } = renderHook(() => useArcaSpeechToText({ sessionId: 's-1', language: 'en', onTranscript }));
    rerender();

    const interimCallsAfterFirstSession = onTranscript.mock.calls.filter((c) => c[1] === false);
    expect(interimCallsAfterFirstSession).toHaveLength(1);
    expect(interimCallsAfterFirstSession[0]![0]).toBe('hello');

    // End the session — pre-fix this left `lastInterimRef` stuck at 'hello'.
    audioMock.isCapturing = true;
    await act(async () => {
      await result.current.stopTranscription();
    });

    // A NEW session's first interim happens to repeat the same text. The
    // store's `currentTranscript` must actually change value (React skips an
    // effect whose dependency is unchanged), so go through '' first — exactly
    // what a fresh capture does (interim starts empty).
    mockState = baseState({ currentTranscript: '' });
    rerender();
    mockState = baseState({ currentTranscript: 'hello' });
    rerender();

    const interimCallsAfterSecondSession = onTranscript.mock.calls.filter((c) => c[1] === false);
    expect(interimCallsAfterSecondSession).toHaveLength(2);
    expect(interimCallsAfterSecondSession[1]![0]).toBe('hello');
  });
});
