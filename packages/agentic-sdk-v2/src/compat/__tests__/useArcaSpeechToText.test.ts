/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useArcaSpeechToText } from '../useArcaSpeechToText';
import { useArcaAudio } from '../../hooks/useArcaAudio';
import { useAgenticStore } from '../../store/agenticStore';

vi.mock('../../hooks/useArcaAudio', () => ({
  useArcaAudio: vi.fn(),
}));

vi.mock('../../store/agenticStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/agenticStore')>();
  return { ...actual, useAgenticStore: vi.fn() };
});

type MockState = { transcriptSegments: unknown[]; currentTranscript: string };

function installStore(state: MockState) {
  (useAgenticStore as unknown as ReturnType<typeof vi.fn>).mockImplementation((selector: (s: MockState) => unknown) =>
    selector(state),
  );
}

const audioMock = {
  isCapturing: false,
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
};

const baseProps = {
  sessionId: 'session-1',
  language: 'en',
  onTranscript: vi.fn(),
};

describe('useArcaSpeechToText', () => {
  beforeEach(() => {
    (useArcaAudio as unknown as ReturnType<typeof vi.fn>).mockReturnValue(audioMock);
  });

  it('fires onTranscript(text, true, meta) for a new final segment', () => {
    const onTranscript = vi.fn();
    const state: MockState = { transcriptSegments: [], currentTranscript: '' };
    installStore(state);

    const { rerender } = renderHook(() => useArcaSpeechToText({ ...baseProps, onTranscript }));

    state.transcriptSegments = [
      { text: 'chest pain for two days', isFinal: true, startTime: 1, endTime: 3, speakerLabel: 'Doctor', confidence: 0.9, language: 'en' },
    ];
    act(() => rerender());

    expect(onTranscript).toHaveBeenCalledWith('chest pain for two days', true, expect.objectContaining({ isFinal: true, speaker_id: 'Doctor' }));
  });

  it('fires onTranscript(text, false, meta) for an interim update', () => {
    const onTranscript = vi.fn();
    const state: MockState = { transcriptSegments: [], currentTranscript: '' };
    installStore(state);

    const { rerender } = renderHook(() => useArcaSpeechToText({ ...baseProps, onTranscript }));

    state.currentTranscript = 'partial words';
    act(() => rerender());

    expect(onTranscript).toHaveBeenCalledWith('partial words', false, expect.objectContaining({ isFinal: false }));
  });

  it('applies the transcriptTemplate', () => {
    const onTranscript = vi.fn();
    const state: MockState = { transcriptSegments: [], currentTranscript: '' };
    installStore(state);

    const { rerender } = renderHook(() =>
      useArcaSpeechToText({ ...baseProps, onTranscript, transcriptTemplate: '{speaker_id}: {text}' }),
    );

    state.transcriptSegments = [{ text: 'hello', isFinal: true, startTime: 0, endTime: 1, speakerLabel: 'Nurse' }];
    act(() => rerender());

    expect(onTranscript).toHaveBeenCalledWith('Nurse: hello', true, expect.anything());
  });

  it('sendAudioData records metadata without throwing and does not push PCM', () => {
    installStore({ transcriptSegments: [], currentTranscript: '' });
    const { result } = renderHook(() => useArcaSpeechToText(baseProps));

    const buffer = new ArrayBuffer(320);
    expect(() => result.current.sendAudioData(buffer, { deviceid: 'mic-1', role: 'doctor' })).not.toThrow();
    // v2 owns transport: sendAudioData never drives audio.start / a PCM push.
    expect(audioMock.start).not.toHaveBeenCalled();
  });

  it('startTranscription drives audio.start; idempotent when already capturing', async () => {
    installStore({ transcriptSegments: [], currentTranscript: '' });
    const { result } = renderHook(() => useArcaSpeechToText(baseProps));
    await act(async () => {
      await result.current.startTranscription();
    });
    expect(audioMock.start).toHaveBeenCalledWith({ language: 'en' });

    audioMock.start.mockClear();
    audioMock.isCapturing = true;
    await act(async () => {
      await result.current.startTranscription();
    });
    expect(audioMock.start).not.toHaveBeenCalled();
    audioMock.isCapturing = false;
  });
});
