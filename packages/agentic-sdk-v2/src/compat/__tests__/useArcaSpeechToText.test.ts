/**
 * @vitest-environment jsdom
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useArcaSpeechToText } from '../useArcaSpeechToText';
import { useArcaAudio } from '../../hooks/useArcaAudio';
import { useAgenticStore } from '../../store/agenticStore';
import {
  composeDeliveredMetadata,
  resolveChunkId,
  resolveDetectedLanguage,
  pickMetadataForFinal,
  DEFAULT_TRANSCRIPT_TEMPLATE,
} from '../speechToTextMetadata';

vi.mock('../../hooks/useArcaAudio', () => ({
  useArcaAudio: vi.fn(),
}));

vi.mock('../../store/agenticStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/agenticStore')>();
  return { ...actual, useAgenticStore: vi.fn() };
});

type MockState = { transcriptSegments: unknown[]; currentTranscript: string };

function installStore(state: MockState) {
  (useAgenticStore as unknown as ReturnType<typeof vi.fn>).mockImplementation((selector: (s: MockState) => unknown) => selector(state));
}

const audioMock = {
  isCapturing: false,
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
  // Streaming STT connection / active-pipeline surface (TASK-567 Phase F) that
  // the onStatus wiring (TASK-568 D-2) observes. Reset in beforeEach.
  sttConnectionState: 'connected' as string,
  activePipeline: null as { id: string; name?: string; isFallback: boolean } | null,
};

const baseProps = {
  sessionId: 'session-1',
  language: 'en',
  onTranscript: vi.fn(),
};

// ---------------------------------------------------------------------------
// Pure helpers (the contract crux — TASK-564 §5.2 / §4.3)
// ---------------------------------------------------------------------------

describe('composeDeliveredMetadata — F4 precedence', () => {
  it('lets caller keys OVERRIDE hook enrichments; enrichments only fill unset keys', () => {
    const out = composeDeliveredMetadata({
      seg: { speakerLabel: 'Doctor', confidence: 0.9, language: 'en', startTime: 1, endTime: 2 },
      isFinal: true,
      callerMeta: { speaker_id: 'app-x', confidence: 0.1, isFinal: 'nope', role: 'clinician' },
    });
    // caller wins over the segment's own diarization/confidence/isFinal
    expect(out.speaker_id).toBe('app-x');
    expect(out.confidence).toBe(0.1);
    expect(out.isFinal).toBe('nope');
    expect(out.role).toBe('clinician');
    // enrichment fills a key the caller did not set
    expect(out.language).toBe('en');
    expect(out.startTime).toBe(1);
  });

  it('lets caller `language` OVERRIDE the segment language enrichment (F4)', () => {
    const out = composeDeliveredMetadata({
      seg: { language: 'en', speakerLabel: 'Doctor' },
      isFinal: true,
      callerMeta: { language: 'ml' },
    });
    // caller wins over the seg.language enrichment
    expect(out.language).toBe('ml');
    // detected_language (§4.3) is independent — caller set no detected_language/detectedLanguage,
    // so it normalizes off seg.language, NOT the caller's `language` key
    expect(out.detected_language).toBe('en');
  });

  it('overlays chunk_id / detected_language LAST (highest precedence)', () => {
    const out = composeDeliveredMetadata({
      seg: { language: 'en' },
      isFinal: true,
      callerMeta: { chunk_id: 'c1', detected_language: 'ml' },
    });
    expect(out.chunk_id).toBe('c1');
    expect(out.detected_language).toBe('ml');
  });

  it('omits chunk_id / detected_language when neither caller nor seg provide them', () => {
    const out = composeDeliveredMetadata({ seg: {}, isFinal: false, callerMeta: undefined });
    expect('chunk_id' in out).toBe(false);
    expect('detected_language' in out).toBe(false);
    expect(out.isFinal).toBe(false);
  });
});

describe('resolveChunkId (§4.3 priority)', () => {
  it('prefers chunk_id → chunkId → other', () => {
    expect(resolveChunkId({ chunk_id: 'c1', chunkId: 'c2', other: 'c3' })).toBe('c1');
    expect(resolveChunkId({ chunkId: 'c2', other: 'c3' })).toBe('c2');
    expect(resolveChunkId({ other: 'c3' })).toBe('c3');
    expect(resolveChunkId({})).toBeUndefined();
    expect(resolveChunkId(undefined)).toBeUndefined();
  });
});

describe('resolveDetectedLanguage (§4.3 priority)', () => {
  it('prefers detected_language → detectedLanguage → seg.language', () => {
    expect(resolveDetectedLanguage({ detected_language: 'ml', detectedLanguage: 'hi' }, { language: 'en' })).toBe('ml');
    expect(resolveDetectedLanguage({ detectedLanguage: 'hi' }, { language: 'en' })).toBe('hi');
    expect(resolveDetectedLanguage({}, { language: 'en' })).toBe('en');
    expect(resolveDetectedLanguage(undefined, {})).toBeUndefined();
  });
});

describe('pickMetadataForFinal — capture-relative timeline base', () => {
  const tl = [
    { atMs: 100, metadata: { role: 'clinician' } },
    { atMs: 3000, metadata: { role: 'patient' } },
  ];

  it('compares startTime*1000 (ms) against the wall-clock-relative atMs base', () => {
    // startTime=1s → 1000ms: only the atMs=100 entry precedes.
    expect(pickMetadataForFinal(tl, 1, 0)).toEqual({ role: 'clinician' });
    // startTime=4s → 4000ms: both precede, latest wins.
    expect(pickMetadataForFinal(tl, 4, 0)).toEqual({ role: 'patient' });
  });

  it('falls back to most-recent when nothing precedes the segment', () => {
    // startTime=0 → 0ms: no atMs ≤ 0 → most-recent (patient).
    expect(pickMetadataForFinal(tl, 0, 0)).toEqual({ role: 'patient' });
  });

  it('degrades to sticky (most-recent) when captureStartMs/startTime is unknown', () => {
    expect(pickMetadataForFinal(tl, undefined, 0)).toEqual({ role: 'patient' });
    expect(pickMetadataForFinal(tl, 1, undefined)).toEqual({ role: 'patient' });
  });
});

// ---------------------------------------------------------------------------
// Hook behavior
// ---------------------------------------------------------------------------

describe('useArcaSpeechToText', () => {
  beforeEach(() => {
    audioMock.isCapturing = false;
    audioMock.sttConnectionState = 'connected';
    audioMock.activePipeline = null;
    audioMock.start.mockClear().mockResolvedValue(undefined);
    audioMock.stop.mockClear().mockResolvedValue(undefined);
    (useArcaAudio as unknown as ReturnType<typeof vi.fn>).mockReturnValue(audioMock);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('fires onTranscript(text, true, meta) for a new final segment (default template applied)', () => {
    const onTranscript = vi.fn();
    const state: MockState = { transcriptSegments: [], currentTranscript: '' };
    installStore(state);

    const { rerender } = renderHook(() => useArcaSpeechToText({ ...baseProps, onTranscript }));

    state.transcriptSegments = [
      { text: 'chest pain for two days', isFinal: true, startTime: 1, endTime: 3, speakerLabel: 'Doctor', confidence: 0.9, language: 'en' },
    ];
    act(() => rerender());

    // default `"{timestamp} {speaker_id}: {text}"` → "1 Doctor: chest pain for two days"
    expect(onTranscript).toHaveBeenCalledWith(
      '1 Doctor: chest pain for two days',
      true,
      expect.objectContaining({ isFinal: true, speaker_id: 'Doctor', confidence: 0.9, language: 'en' }),
    );
  });

  it('renders the default template with an empty slot for a missing speaker (no "undefined")', () => {
    const onTranscript = vi.fn();
    const state: MockState = { transcriptSegments: [], currentTranscript: '' };
    installStore(state);

    const { rerender } = renderHook(() => useArcaSpeechToText({ ...baseProps, onTranscript }));

    state.transcriptSegments = [{ text: 'hello', isFinal: true, startTime: 0, endTime: 1 }];
    act(() => rerender());

    expect(onTranscript.mock.calls[0][0]).toBe('0 : hello');
    expect(onTranscript.mock.calls[0][0]).not.toContain('undefined');
    expect(DEFAULT_TRANSCRIPT_TEMPLATE).toBe('{timestamp} {speaker_id}: {text}');
  });

  it('fires onTranscript(text, false, meta) for an interim update (raw text)', () => {
    const onTranscript = vi.fn();
    const state: MockState = { transcriptSegments: [], currentTranscript: '' };
    installStore(state);

    const { rerender } = renderHook(() => useArcaSpeechToText({ ...baseProps, onTranscript }));

    state.currentTranscript = 'partial words';
    act(() => rerender());

    expect(onTranscript).toHaveBeenCalledWith('partial words', false, expect.objectContaining({ isFinal: false }));
  });

  it('honors an explicit transcriptTemplate on finals', () => {
    const onTranscript = vi.fn();
    const state: MockState = { transcriptSegments: [], currentTranscript: '' };
    installStore(state);

    const { rerender } = renderHook(() => useArcaSpeechToText({ ...baseProps, onTranscript, transcriptTemplate: '{speaker_id}: {text}' }));

    state.transcriptSegments = [{ text: 'hello', isFinal: true, startTime: 0, endTime: 1, speakerLabel: 'Nurse' }];
    act(() => rerender());

    expect(onTranscript).toHaveBeenCalledWith('Nurse: hello', true, expect.anything());
  });

  it('F4: caller metadata survives on a delivered final even when the segment has its own fields', () => {
    const onTranscript = vi.fn();
    const state: MockState = { transcriptSegments: [], currentTranscript: '' };
    installStore(state);

    const { result, rerender } = renderHook(() => useArcaSpeechToText({ ...baseProps, onTranscript }));

    act(() => result.current.sendAudioData(new ArrayBuffer(8), { speaker_id: 'app-x', confidence: 0.1, chunk_id: 'c1' }));

    state.transcriptSegments = [{ text: 'x', isFinal: true, startTime: 1, endTime: 2, speakerLabel: 'Doctor', confidence: 0.9, language: 'en' }];
    act(() => rerender());

    const meta = onTranscript.mock.calls[onTranscript.mock.calls.length - 1][2] as Record<string, unknown>;
    expect(meta.speaker_id).toBe('app-x'); // caller over diarization
    expect(meta.confidence).toBe(0.1); // caller over seg.confidence
    expect(meta.chunk_id).toBe('c1'); // §4.3 overlay
    expect(meta.language).toBe('en'); // enrichment fills unset key
  });

  it('normalizes chunk_id and detected_language onto delivered finals (§4.3)', () => {
    const onTranscript = vi.fn();
    const state: MockState = { transcriptSegments: [], currentTranscript: '' };
    installStore(state);

    const { result, rerender } = renderHook(() => useArcaSpeechToText({ ...baseProps, onTranscript }));

    act(() => result.current.sendAudioData(new ArrayBuffer(8), { chunkId: 'c2', detectedLanguage: 'ml' }));

    state.transcriptSegments = [{ text: 'x', isFinal: true, startTime: 1, endTime: 2, language: 'en' }];
    act(() => rerender());

    const meta = onTranscript.mock.calls[onTranscript.mock.calls.length - 1][2] as Record<string, unknown>;
    expect(meta.chunk_id).toBe('c2');
    expect(meta.detected_language).toBe('ml');
  });

  it('correlates finals to caller metadata via the capture-relative timeline', async () => {
    const onTranscript = vi.fn();
    const state: MockState = { transcriptSegments: [], currentTranscript: '' };
    installStore(state);
    const now = vi.spyOn(Date, 'now');

    const { result, rerender } = renderHook(() => useArcaSpeechToText({ ...baseProps, onTranscript }));

    now.mockReturnValue(1000); // captureStartMs = 1000
    await act(async () => {
      await result.current.startTranscription();
    });

    now.mockReturnValue(1100); // atMs = 100
    act(() => result.current.sendAudioData(new ArrayBuffer(8), { role: 'clinician' }));
    now.mockReturnValue(4000); // atMs = 3000
    act(() => result.current.sendAudioData(new ArrayBuffer(8), { role: 'patient' }));

    // final at startTime=1s (1000ms) → clinician window
    state.transcriptSegments = [{ text: 'a', isFinal: true, startTime: 1, endTime: 2 }];
    act(() => rerender());
    expect((onTranscript.mock.calls[onTranscript.mock.calls.length - 1][2] as Record<string, unknown>).role).toBe('clinician');

    // final at startTime=4s (4000ms) → patient window
    state.transcriptSegments = [
      { text: 'a', isFinal: true, startTime: 1, endTime: 2 },
      { text: 'b', isFinal: true, startTime: 4, endTime: 5 },
    ];
    act(() => rerender());
    expect((onTranscript.mock.calls[onTranscript.mock.calls.length - 1][2] as Record<string, unknown>).role).toBe('patient');
  });

  it('falls back to most-recent metadata when no timeline entry precedes the final', async () => {
    const onTranscript = vi.fn();
    const state: MockState = { transcriptSegments: [], currentTranscript: '' };
    installStore(state);
    const now = vi.spyOn(Date, 'now');

    const { result, rerender } = renderHook(() => useArcaSpeechToText({ ...baseProps, onTranscript }));

    now.mockReturnValue(1000);
    await act(async () => {
      await result.current.startTranscription();
    });
    now.mockReturnValue(5000); // atMs = 4000 (all entries are AFTER the final's window)
    act(() => result.current.sendAudioData(new ArrayBuffer(8), { role: 'late' }));

    state.transcriptSegments = [{ text: 'a', isFinal: true, startTime: 1, endTime: 2 }]; // 1000ms < 4000ms
    act(() => rerender());
    expect((onTranscript.mock.calls[onTranscript.mock.calls.length - 1][2] as Record<string, unknown>).role).toBe('late');
  });

  it('interims use the most-recent timeline metadata (sticky)', () => {
    const onTranscript = vi.fn();
    const state: MockState = { transcriptSegments: [], currentTranscript: '' };
    installStore(state);

    const { result, rerender } = renderHook(() => useArcaSpeechToText({ ...baseProps, onTranscript }));

    act(() => result.current.sendAudioData(new ArrayBuffer(8), { role: 'clinician' }));
    act(() => result.current.sendAudioData(new ArrayBuffer(8), { role: 'patient' }));

    state.currentTranscript = 'partial';
    act(() => rerender());
    expect((onTranscript.mock.calls[onTranscript.mock.calls.length - 1][2] as Record<string, unknown>).role).toBe('patient');
  });

  it('degrades to sticky (most-recent) when capture never started', () => {
    const onTranscript = vi.fn();
    const state: MockState = { transcriptSegments: [], currentTranscript: '' };
    installStore(state);

    const { result, rerender } = renderHook(() => useArcaSpeechToText({ ...baseProps, onTranscript }));

    // No startTranscription → captureStartMs undefined → pure sticky path.
    act(() => result.current.sendAudioData(new ArrayBuffer(8), { role: 'first' }));
    act(() => result.current.sendAudioData(new ArrayBuffer(8), { role: 'second' }));

    state.transcriptSegments = [{ text: 'a', isFinal: true, startTime: 99, endTime: 100 }];
    act(() => rerender());
    expect((onTranscript.mock.calls[onTranscript.mock.calls.length - 1][2] as Record<string, unknown>).role).toBe('second');
  });

  it('sendAudioData records metadata without throwing and does not push PCM', () => {
    installStore({ transcriptSegments: [], currentTranscript: '' });
    const { result } = renderHook(() => useArcaSpeechToText(baseProps));

    const buffer = new ArrayBuffer(320);
    expect(() => result.current.sendAudioData(buffer, { deviceid: 'mic-1', role: 'doctor' })).not.toThrow();
    expect(audioMock.start).not.toHaveBeenCalled();
  });

  it('throws the v1 message when metadata exceeds 8 KiB; accepts payloads at/below the limit', () => {
    installStore({ transcriptSegments: [], currentTranscript: '' });
    const { result } = renderHook(() => useArcaSpeechToText(baseProps));

    expect(() => result.current.sendAudioData(new ArrayBuffer(8), { blob: 'x'.repeat(9000) })).toThrow('Audio frame metadata exceeds 8192 bytes');
    expect(() => result.current.sendAudioData(new ArrayBuffer(8), { blob: 'x'.repeat(100) })).not.toThrow();
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

  // TASK-567 §2.4: v1 accepted the backend ASR pipeline via `options`; the
  // compat hook previously dropped it, always falling back to the default
  // pipeline. It must now forward `options.pipelineId` to audio.start(...).
  it('forwards options.pipelineId to audio.start (fixes the §2.4 drop)', async () => {
    installStore({ transcriptSegments: [], currentTranscript: '' });
    audioMock.start.mockClear();
    const { result } = renderHook(() => useArcaSpeechToText({ ...baseProps, options: { pipelineId: 'azure_speech_transcription' } }));
    await act(async () => {
      await result.current.startTranscription();
    });
    expect(audioMock.start).toHaveBeenCalledWith({ language: 'en', pipelineId: 'azure_speech_transcription' });
  });

  it('omits pipelineId when options has none (backwards compatible)', async () => {
    installStore({ transcriptSegments: [], currentTranscript: '' });
    audioMock.start.mockClear();
    const { result } = renderHook(() => useArcaSpeechToText(baseProps));
    await act(async () => {
      await result.current.startTranscription();
    });
    expect(audioMock.start).toHaveBeenCalledWith({ language: 'en' });
  });

  // TASK-568 D-2: the already-frozen-but-unwired `onStatus` prop now surfaces the
  // v2 provider_switched + reconnect transitions. Zero signature change.
  it('fires onStatus("provider_switched", {fromPipeline,toPipeline}) when the active pipeline flips to fallback', () => {
    const onStatus = vi.fn();
    installStore({ transcriptSegments: [], currentTranscript: '' });
    audioMock.activePipeline = { id: 'primary', isFallback: false };

    const { rerender } = renderHook(() => useArcaSpeechToText({ ...baseProps, onStatus }));

    audioMock.activePipeline = { id: 'fallback', isFallback: true };
    audioMock.sttConnectionState = 'switched_fallback';
    act(() => rerender());

    expect(onStatus).toHaveBeenCalledWith('provider_switched', { fromPipeline: 'primary', toPipeline: 'fallback' });
  });

  it('fires onStatus("reconnecting") then onStatus("reconnected") across a reconnect', () => {
    const onStatus = vi.fn();
    installStore({ transcriptSegments: [], currentTranscript: '' });

    const { rerender } = renderHook(() => useArcaSpeechToText({ ...baseProps, onStatus }));

    audioMock.sttConnectionState = 'reconnecting';
    act(() => rerender());
    expect(onStatus).toHaveBeenCalledWith('reconnecting');

    audioMock.sttConnectionState = 'connected';
    act(() => rerender());
    expect(onStatus).toHaveBeenCalledWith('reconnected');
  });

  it('apps that never pass onStatus are unaffected by a provider switch (no throw)', () => {
    installStore({ transcriptSegments: [], currentTranscript: '' });
    audioMock.activePipeline = { id: 'primary', isFallback: false };

    const { rerender } = renderHook(() => useArcaSpeechToText(baseProps));

    audioMock.activePipeline = { id: 'fallback', isFallback: true };
    expect(() => act(() => rerender())).not.toThrow();
  });

  // TASK-568 §5.6: a provider switch must NOT disturb the metadata timeline —
  // capture never stops, so entries recorded before the switch still correlate
  // to finals after it (extends the TASK-565 timeline tests).
  it('metadata timeline survives a provider switch (caller metadata still correlates to post-switch finals)', async () => {
    const onTranscript = vi.fn();
    const state: MockState = { transcriptSegments: [], currentTranscript: '' };
    installStore(state);
    const now = vi.spyOn(Date, 'now');
    audioMock.activePipeline = { id: 'primary', isFallback: false };

    const { result, rerender } = renderHook(() => useArcaSpeechToText({ ...baseProps, onTranscript }));

    now.mockReturnValue(1000); // captureStartMs = 1000
    await act(async () => {
      await result.current.startTranscription();
    });

    now.mockReturnValue(1100); // atMs = 100
    act(() => result.current.sendAudioData(new ArrayBuffer(8), { role: 'clinician', chunk_id: 'c1' }));

    // Provider switches mid-session (capture keeps running).
    audioMock.activePipeline = { id: 'fallback', isFallback: true };
    act(() => rerender());

    // A final in the pre-switch window still carries the caller metadata.
    state.transcriptSegments = [{ text: 'chest pain', isFinal: true, startTime: 1, endTime: 2 }];
    act(() => rerender());

    const meta = onTranscript.mock.calls[onTranscript.mock.calls.length - 1][2] as Record<string, unknown>;
    expect(meta.role).toBe('clinician');
    expect(meta.chunk_id).toBe('c1');
  });
});
