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

// The frozen v1 upload members are now real, so the file-transcription
// service is stubbed the same way the batch-hook suite stubs it.
const fileServiceMocks = vi.hoisted(() => {
  const upload = vi.fn();
  const getJob = vi.fn();
  class MockFileTranscriptionService {
    uploadAndTranscribeWithProgress = upload;
    getJob = getJob;
    cancelJob = vi.fn();
    dispose = vi.fn();
    buildJobStreamUrl = (jobId: string) => `https://api.test/api/v1/audio/transcription-jobs/${jobId}/stream`;
  }
  return { upload, getJob, MockFileTranscriptionService };
});

vi.mock('../../core/FileTranscriptionService', () => ({ FileTranscriptionService: fileServiceMocks.MockFileTranscriptionService }));

vi.mock('../../store/agenticStore', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../store/agenticStore')>();
  return { ...actual, useAgenticStore: vi.fn() };
});

type MockState = {
  transcriptSegments: unknown[];
  currentTranscript: string;
  // useArcaSpeechToText publishes the selected language/mode into the
  // store; `installStore` fills these action selectors (optional so tests can
  // declare the state with just the transcript fields).
  setAudioLanguage?: (language: string) => void;
  setSttLanguageMode?: (mode: string | undefined) => void;
  // The pre-start engine selection consumed at `audio.start`.
  pendingSttProvider?: 'primary' | 'fallback' | null;
  setPendingSttProvider?: (v: 'primary' | 'fallback' | null) => void;
  // The client the (now real) v1 upload members run through.
  apiClient?: unknown;
  logger?: unknown;
};

/** Stand-in for the SDK API client; only its identity matters to these tests. */
const apiClientStub = { getBaseUrl: () => 'https://api.test/api/v1' };

function installStore(state: Pick<MockState, 'transcriptSegments' | 'currentTranscript'> & Partial<MockState>) {
  // Augment the SAME object in place (do NOT copy) — several tests reassign
  // `state.transcriptSegments` after install and rerender, relying on the mock
  // reading the live reference.
  state.setAudioLanguage ??= vi.fn();
  state.setSttLanguageMode ??= vi.fn();
  state.pendingSttProvider ??= null;
  state.setPendingSttProvider ??= vi.fn((v: 'primary' | 'fallback' | null) => {
    state.pendingSttProvider = v;
  });
  if (!('apiClient' in state)) state.apiClient = apiClientStub;
  state.logger ??= null;
  (useAgenticStore as unknown as ReturnType<typeof vi.fn>).mockImplementation((selector: (s: MockState) => unknown) => selector(state as MockState));
}

const audioMock = {
  isCapturing: false,
  start: vi.fn().mockResolvedValue(undefined),
  stop: vi.fn().mockResolvedValue(undefined),
  // Streaming STT connection / active-pipeline surface that
  // the onStatus wiring observes. Reset in beforeEach.
  sttConnectionState: 'connected' as string,
  activePipeline: null as { id: string; name?: string; isFallback: boolean } | null,
};

const baseProps = {
  sessionId: 'session-1',
  language: 'en',
  onTranscript: vi.fn(),
};

// ---------------------------------------------------------------------------
// Pure helpers (the contract crux)
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
    // detected_language is independent — caller set no detected_language/detectedLanguage
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

describe('resolveChunkId (priority)', () => {
  it('prefers chunk_id → chunkId → other', () => {
    expect(resolveChunkId({ chunk_id: 'c1', chunkId: 'c2', other: 'c3' })).toBe('c1');
    expect(resolveChunkId({ chunkId: 'c2', other: 'c3' })).toBe('c2');
    expect(resolveChunkId({ other: 'c3' })).toBe('c3');
    expect(resolveChunkId({})).toBeUndefined();
    expect(resolveChunkId(undefined)).toBeUndefined();
  });
});

describe('resolveDetectedLanguage (priority)', () => {
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

  it('publishes language + languageMode to the store so a capture-first start honors the selection', () => {
    const state: MockState = { transcriptSegments: [], currentTranscript: '' } as MockState;
    installStore(state);

    renderHook(() =>
      useArcaSpeechToText({ ...baseProps, language: 'en', options: { languageMode: 'en' } }),
    );

    // The store is the order-independent channel `useArcaAudio.startAudio` reads
    // as a fallback when `useAudioCapture` wins the `audio.start` race.
    expect(state.setAudioLanguage).toHaveBeenCalledWith('en');
    expect(state.setSttLanguageMode).toHaveBeenCalledWith('en');
  });

  it('startTranscription passes the pending pre-start provider as startOn and clears it', async () => {
    const state: MockState = { transcriptSegments: [], currentTranscript: '', pendingSttProvider: 'fallback' } as MockState;
    installStore(state);

    const { result } = renderHook(() =>
      useArcaSpeechToText({ ...baseProps, options: { pipelineId: 'p1' } }),
    );
    await act(async () => {
      await result.current.startTranscription();
    });

    expect(audioMock.start).toHaveBeenCalledWith(expect.objectContaining({ startOn: 'fallback' }));
    expect(state.setPendingSttProvider).toHaveBeenCalledWith(null);
  });

  it('startTranscription omits startOn when no pre-start selection is pending', async () => {
    const state: MockState = { transcriptSegments: [], currentTranscript: '' } as MockState;
    installStore(state);

    const { result } = renderHook(() => useArcaSpeechToText({ ...baseProps, options: { pipelineId: 'p1' } }));
    await act(async () => {
      await result.current.startTranscription();
    });

    expect(audioMock.start).toHaveBeenCalledWith(expect.not.objectContaining({ startOn: expect.anything() }));
    expect(state.setPendingSttProvider).not.toHaveBeenCalled();
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
    expect(meta.chunk_id).toBe('c1'); // chunk_id overlay
    expect(meta.language).toBe('en'); // enrichment fills unset key
  });

  it('normalizes chunk_id and detected_language onto delivered finals', () => {
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

  // V1 accepted the backend ASR pipeline via `options`; the
  // compat hook previously dropped it, always falling back to the default
  // pipeline. It must now forward `options.pipelineId` to audio.start(...).
  it('forwards options.pipelineId to audio.start (fixes the drop)', async () => {
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

  // The already-frozen-but-unwired `onStatus` prop now surfaces the
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

  // A provider switch must NOT disturb the metadata timeline
  // capture never stops, so entries recorded before the switch still correlate
  // to finals after it (extends the timeline tests).
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

// ---------------------------------------------------------------------------
// The frozen v1 upload members, now real
//
// v1's `useArcaSpeechToText` shipped `uploadAudioFile` / `getTranscriptionStatus`
// / `isUploading` / `uploadProgress`; compat used to throw on the first two and
// hardcode the last two. These tests pin the real behaviour AND the fact that
// the signature did not move — a migrating v1 app must keep compiling.
// ---------------------------------------------------------------------------
describe('useArcaSpeechToText — v1 file upload', () => {
  beforeEach(() => {
    fileServiceMocks.upload.mockReset();
    fileServiceMocks.getJob.mockReset();
    fileServiceMocks.upload.mockResolvedValue({ id: 'job-9', status: 'QUEUED' });
    fileServiceMocks.getJob.mockResolvedValue({ id: 'job-9', status: 'COMPLETED', resultText: 'done' });
    (useArcaAudio as unknown as ReturnType<typeof vi.fn>).mockReturnValue(audioMock);
  });

  const wavFile = () => new File([new Uint8Array(64)], 'clip.wav', { type: 'audio/wav' });

  it('uploads through the configured pipeline and resolves the job id (v1 returned the task id)', async () => {
    installStore({ transcriptSegments: [], currentTranscript: '' });
    const { result } = renderHook(() => useArcaSpeechToText({ ...baseProps, options: { pipelineId: 'pipe-cfg' } }));

    let taskId = '';
    await act(async () => {
      taskId = await result.current.uploadAudioFile(wavFile(), 'ml');
    });

    expect(taskId).toBe('job-9');
    expect(fileServiceMocks.upload).toHaveBeenCalledTimes(1);
    expect(fileServiceMocks.upload.mock.calls[0][1]).toMatchObject({ pipelineId: 'pipe-cfg', language: 'ml' });
  });

  it('treats the v1 `provider` argument as a pipeline override', async () => {
    installStore({ transcriptSegments: [], currentTranscript: '' });
    const { result } = renderHook(() => useArcaSpeechToText({ ...baseProps, options: { pipelineId: 'pipe-cfg' } }));

    await act(async () => {
      await result.current.uploadAudioFile(wavFile(), 'en', 'pipe-override');
    });

    expect(fileServiceMocks.upload.mock.calls[0][1]).toMatchObject({ pipelineId: 'pipe-override' });
  });

  it('rejects with an actionable error when no pipeline is resolvable', async () => {
    installStore({ transcriptSegments: [], currentTranscript: '' });
    const { result } = renderHook(() => useArcaSpeechToText(baseProps));

    await expect(result.current.uploadAudioFile(wavFile(), 'en')).rejects.toThrow(/pipelineId/i);
    expect(fileServiceMocks.upload).not.toHaveBeenCalled();
  });

  it('drives isUploading / uploadProgress instead of the old hardcoded false/0', async () => {
    installStore({ transcriptSegments: [], currentTranscript: '' });
    let releaseUpload!: (value: unknown) => void;
    fileServiceMocks.upload.mockImplementationOnce((_file: File, options: { onProgress?: (p: number) => void }) => {
      return new Promise((resolve) => {
        options.onProgress?.(42);
        releaseUpload = resolve;
      });
    });

    const { result } = renderHook(() => useArcaSpeechToText({ ...baseProps, options: { pipelineId: 'pipe-cfg' } }));
    expect(result.current.isUploading).toBe(false);

    let pending!: Promise<string>;
    await act(async () => {
      pending = result.current.uploadAudioFile(wavFile(), 'en');
    });

    expect(result.current.isUploading).toBe(true);
    expect(result.current.uploadProgress).toBe(42);

    await act(async () => {
      releaseUpload({ id: 'job-9', status: 'QUEUED' });
      await pending;
    });

    expect(result.current.isUploading).toBe(false);
    expect(result.current.uploadProgress).toBe(100);
  });

  it('surfaces an upload failure on `error` + onError and clears isUploading', async () => {
    installStore({ transcriptSegments: [], currentTranscript: '' });
    fileServiceMocks.upload.mockRejectedValueOnce(new Error('415 unsupported audio type'));
    const onError = vi.fn();
    const { result } = renderHook(() => useArcaSpeechToText({ ...baseProps, options: { pipelineId: 'pipe-cfg' }, onError }));

    await act(async () => {
      await expect(result.current.uploadAudioFile(wavFile(), 'en')).rejects.toThrow(/415/);
    });

    expect(result.current.isUploading).toBe(false);
    expect(result.current.error?.message).toContain('415');
    expect(onError).toHaveBeenCalledTimes(1);
  });

  it('getTranscriptionStatus reads the job back by id', async () => {
    installStore({ transcriptSegments: [], currentTranscript: '' });
    const { result } = renderHook(() => useArcaSpeechToText({ ...baseProps, options: { pipelineId: 'pipe-cfg' } }));

    let job: unknown;
    await act(async () => {
      job = await result.current.getTranscriptionStatus('job-9');
    });

    expect(fileServiceMocks.getJob).toHaveBeenCalledWith('job-9');
    expect(job).toMatchObject({ id: 'job-9', status: 'COMPLETED' });
  });

  it('rejects both members with a clear message when the SDK has no apiClient', async () => {
    installStore({ transcriptSegments: [], currentTranscript: '', apiClient: null });
    const { result } = renderHook(() => useArcaSpeechToText({ ...baseProps, options: { pipelineId: 'pipe-cfg' } }));

    await expect(result.current.uploadAudioFile(wavFile(), 'en')).rejects.toThrow(/not initialized/i);
    await expect(result.current.getTranscriptionStatus('job-9')).rejects.toThrow(/not initialized/i);
  });
});
